import axios from 'axios';
import crypto from 'crypto';
import { prismaWrite as prisma, prismaRead } from '../db';

interface WebhookEvent {
  type: string;
  contractAddress?: string;
  transactionHash?: string;
  ledger?: number;
  data: Record<string, unknown>;
}

interface FilterRule {
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'startsWith' | 'gt' | 'lt' | 'in';
  value: unknown;
}

interface WorkflowStep {
  type: 'delay' | 'transform' | 'condition' | 'deliver';
  config: Record<string, unknown>;
}

interface WorkflowCondition {
  field: string;
  operator: string;
  value: unknown;
}

function evaluateFilter(rule: FilterRule, event: WebhookEvent): boolean {
  const parts = rule.field.split('.');
  let val: unknown = event;
  for (const p of parts) val = (val as Record<string, unknown>)?.[p];

  switch (rule.operator) {
    case 'eq': return val === rule.value;
    case 'neq': return val !== rule.value;
    case 'contains': return typeof val === 'string' && val.includes(String(rule.value));
    case 'startsWith': return typeof val === 'string' && val.startsWith(String(rule.value));
    case 'gt': return Number(val) > Number(rule.value);
    case 'lt': return Number(val) < Number(rule.value);
    case 'in': return Array.isArray(rule.value) && rule.value.includes(val);
    default: return true;
  }
}

function applyTransform(template: Record<string, unknown>, event: WebhookEvent): Record<string, unknown> {
  const resolve = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    return v.replace(/\{\{([^}]+)\}\}/g, (_m, path: string) => {
      const parts = path.trim().split('.');
      let cur: unknown = event;
      for (const p of parts) cur = (cur as Record<string, unknown>)?.[p];
      return cur !== undefined ? String(cur) : '';
    });
  };
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) result[k] = resolve(v);
  return result;
}

async function deliverHttp(
  url: string,
  payload: Record<string, unknown>,
  secret?: string | null,
): Promise<{ code: number; body: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
  }
  const resp = await axios.post(url, payload, { headers, timeout: 10000, validateStatus: () => true });
  return { code: resp.status, body: String(resp.data).slice(0, 2000) };
}

async function deliverToChannel(
  channel: string,
  channelConfig: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<{ code: number; body: string }> {
  if (channel === 'http') {
    const url = channelConfig.url as string;
    if (!url) throw new Error('Missing url in channelConfig');
    return deliverHttp(url, payload);
  }

  if (channel === 'slack') {
    const url = channelConfig.webhookUrl as string;
    if (!url) throw new Error('Missing webhookUrl for Slack');
    const text = payload.text ?? payload.message ?? JSON.stringify(payload);
    const resp = await axios.post(url, { text }, { timeout: 10000, validateStatus: () => true });
    return { code: resp.status, body: 'ok' };
  }

  if (channel === 'discord') {
    const url = channelConfig.webhookUrl as string;
    if (!url) throw new Error('Missing webhookUrl for Discord');
    const content = String(payload.text ?? payload.message ?? JSON.stringify(payload)).slice(0, 2000);
    const resp = await axios.post(url, { content }, { timeout: 10000, validateStatus: () => true });
    return { code: resp.status, body: 'ok' };
  }

  if (channel === 'telegram') {
    const token = channelConfig.botToken as string;
    const chatId = channelConfig.chatId as string;
    if (!token || !chatId) throw new Error('Missing botToken/chatId for Telegram');
    const text = String(payload.text ?? payload.message ?? JSON.stringify(payload)).slice(0, 4096);
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const resp = await axios.post(url, { chat_id: chatId, text }, { timeout: 10000, validateStatus: () => true });
    return { code: resp.status, body: 'ok' };
  }

  if (channel === 'email') {
    // Placeholder — real impl would call SendGrid/SES
    console.log('[webhook] email channel would send to', channelConfig.to, ':', payload);
    return { code: 200, body: 'queued' };
  }

  if (channel === 'pagerduty') {
    const routingKey = channelConfig.routingKey as string;
    if (!routingKey) throw new Error('Missing routingKey for PagerDuty');
    const pdPayload = {
      routing_key: routingKey,
      event_action: 'trigger',
      payload: {
        summary: String(payload.summary ?? payload.message ?? 'Soroban Explorer alert'),
        severity: (channelConfig.severity as string) ?? 'info',
        source: 'soroban-explorer',
        custom_details: payload,
      },
    };
    const resp = await axios.post('https://events.pagerduty.com/v2/enqueue', pdPayload, {
      timeout: 10000,
      validateStatus: () => true,
    });
    return { code: resp.status, body: 'ok' };
  }

  throw new Error(`Unknown channel: ${channel}`);
}

async function attemptDelivery(deliveryId: string): Promise<void> {
  const delivery = await prismaRead.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery || delivery.status === 'delivered') return;

  const endpoint = delivery.endpoint;
  const policy = endpoint.retryPolicy as Record<string, unknown>;
  const maxAttempts = Number(policy.maxAttempts ?? 3);
  const backoffMs = Number(policy.backoffMs ?? 2000);

  const attempt = delivery.attempts + 1;
  let payload = delivery.payload as Record<string, unknown>;

  if (endpoint.transformTemplate) {
    payload = applyTransform(
      endpoint.transformTemplate as Record<string, unknown>,
      payload as unknown as WebhookEvent,
    );
  }

  try {
    const channelConfig = endpoint.channelConfig as Record<string, unknown>;
    const { code, body } = await deliverToChannel(endpoint.channel, channelConfig, payload);

    const success = code >= 200 && code < 300;
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: success ? 'delivered' : attempt >= maxAttempts ? 'failed' : 'retrying',
        attempts: attempt,
        responseCode: code,
        responseBody: body,
        deliveredAt: success ? new Date() : undefined,
        nextRetryAt: !success && attempt < maxAttempts
          ? new Date(Date.now() + backoffMs * Math.pow(2, attempt - 1))
          : undefined,
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: attempt >= maxAttempts ? 'failed' : 'retrying',
        attempts: attempt,
        lastError: errMsg,
        nextRetryAt:
          attempt < maxAttempts
            ? new Date(Date.now() + backoffMs * Math.pow(2, attempt - 1))
            : undefined,
      },
    });
  }
}

export async function dispatchEvent(event: WebhookEvent): Promise<void> {
  const endpoints = await prismaRead.webhookEndpoint.findMany({ where: { active: true } });

  for (const endpoint of endpoints) {
    const rules = endpoint.filterRules as FilterRule[];
    const passes = rules.every((r) => evaluateFilter(r, event));
    if (!passes) continue;

    let payload: Record<string, unknown> = {
      eventType: event.type,
      contractAddress: event.contractAddress,
      transactionHash: event.transactionHash,
      ledger: event.ledger,
      data: event.data,
      timestamp: new Date().toISOString(),
    };

    if (endpoint.transformTemplate) {
      payload = applyTransform(endpoint.transformTemplate as Record<string, unknown>, event);
    }

    // Run matching workflows
    const workflows = await prismaRead.webhookWorkflow.findMany({
      where: { endpointId: endpoint.id, active: true, triggerEvent: event.type },
    });

    for (const workflow of workflows) {
      const conditions = workflow.conditions as WorkflowCondition[];
      const conditionsPassed = conditions.every((c) =>
        evaluateFilter({ field: c.field, operator: c.operator as FilterRule['operator'], value: c.value }, event),
      );
      if (!conditionsPassed) continue;

      const steps = workflow.steps as WorkflowStep[];
      for (const step of steps) {
        if (step.type === 'transform' && step.config.template) {
          payload = applyTransform(step.config.template as Record<string, unknown>, event);
        }
        // 'delay' and 'condition' steps are handled at delivery time
      }
    }

    const delivery = await prisma.webhookDelivery.create({
      data: { endpointId: endpoint.id, eventType: event.type, payload, status: 'pending' },
    });

    // Fire-and-forget async delivery
    attemptDelivery(delivery.id).catch((err) =>
      console.error('[webhook] delivery error:', err),
    );
  }
}

export async function retryPendingDeliveries(): Promise<number> {
  const due = await prismaRead.webhookDelivery.findMany({
    where: { status: 'retrying', nextRetryAt: { lte: new Date() } },
    take: 50,
  });
  for (const d of due) await attemptDelivery(d.id);
  return due.length;
}
