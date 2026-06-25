import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaWrite as prisma, prismaRead } from '../db';
import { dispatchEvent } from '../webhooks/dispatcher';

export const webhookRouter = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const filterRuleSchema = z.object({
  field: z.string(),
  operator: z.enum(['eq', 'neq', 'contains', 'startsWith', 'gt', 'lt', 'in']),
  value: z.unknown(),
});

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffMs: z.number().int().min(100).default(2000),
});

const channelConfigSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('http'), url: z.string().url(), headers: z.record(z.string()).optional() }),
  z.object({ channel: z.literal('slack'), webhookUrl: z.string().url() }),
  z.object({ channel: z.literal('discord'), webhookUrl: z.string().url() }),
  z.object({ channel: z.literal('telegram'), botToken: z.string(), chatId: z.string() }),
  z.object({ channel: z.literal('email'), to: z.string().email(), subject: z.string().optional() }),
  z.object({ channel: z.literal('pagerduty'), routingKey: z.string(), severity: z.enum(['critical', 'error', 'warning', 'info']).default('info') }),
]);

const createEndpointSchema = z.object({
  name: z.string().min(1).max(200),
  ownerId: z.string().min(1),
  channel: z.enum(['http', 'slack', 'discord', 'telegram', 'email', 'pagerduty']).default('http'),
  channelConfig: z.record(z.unknown()).default({}),
  secret: z.string().optional(),
  active: z.boolean().default(true),
  filterRules: z.array(filterRuleSchema).default([]),
  transformTemplate: z.record(z.unknown()).optional(),
  retryPolicy: retryPolicySchema.default({ maxAttempts: 3, backoffMs: 2000 }),
  rateLimit: z.number().int().min(1).max(10000).default(100),
});

const workflowStepSchema = z.object({
  type: z.enum(['delay', 'transform', 'condition', 'deliver']),
  config: z.record(z.unknown()).default({}),
});

const createWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  triggerEvent: z.string().min(1),
  conditions: z.array(filterRuleSchema).default([]),
  steps: z.array(workflowStepSchema).default([]),
  active: z.boolean().default(true),
});

// ─── Endpoints CRUD ───────────────────────────────────────────────────────────

webhookRouter.post('/endpoints', async (req: Request, res: Response) => {
  const parsed = createEndpointSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const endpoint = await prisma.webhookEndpoint.create({ data: parsed.data });
  res.status(201).json(endpoint);
});

webhookRouter.get('/endpoints', async (req: Request, res: Response) => {
  const ownerId = req.query.ownerId as string | undefined;
  const channel = req.query.channel as string | undefined;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, parseInt(req.query.limit as string) || 20);

  const where: Record<string, unknown> = {};
  if (ownerId) where.ownerId = ownerId;
  if (channel) where.channel = channel;

  const [endpoints, total] = await Promise.all([
    prismaRead.webhookEndpoint.findMany({
      where,
      include: { _count: { select: { deliveries: true, workflows: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prismaRead.webhookEndpoint.count({ where }),
  ]);

  res.json({ data: endpoints, total, page, pages: Math.ceil(total / limit) });
});

webhookRouter.get('/endpoints/:id', async (req: Request, res: Response) => {
  const endpoint = await prismaRead.webhookEndpoint.findUnique({
    where: { id: req.params.id },
    include: {
      workflows: true,
      _count: { select: { deliveries: true } },
    },
  });
  if (!endpoint) return res.status(404).json({ error: 'Not found' });
  res.json(endpoint);
});

webhookRouter.put('/endpoints/:id', async (req: Request, res: Response) => {
  const parsed = createEndpointSchema.partial().omit({ ownerId: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prismaRead.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const endpoint = await prisma.webhookEndpoint.update({
    where: { id: req.params.id },
    data: parsed.data,
  });
  res.json(endpoint);
});

webhookRouter.delete('/endpoints/:id', async (req: Request, res: Response) => {
  const existing = await prismaRead.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await prisma.webhookEndpoint.delete({ where: { id: req.params.id } });
  res.json({ deleted: true });
});

// ─── Test Delivery ────────────────────────────────────────────────────────────

webhookRouter.post('/endpoints/:id/test', async (req: Request, res: Response) => {
  const endpoint = await prismaRead.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!endpoint) return res.status(404).json({ error: 'Not found' });

  const testEvent = {
    type: req.body.eventType ?? 'test',
    contractAddress: req.body.contractAddress ?? 'CTEST000000000000000000000000000000000000000000000000000000',
    transactionHash: req.body.transactionHash ?? 'test-tx-hash',
    ledger: req.body.ledger ?? 0,
    data: req.body.data ?? { message: 'This is a test webhook delivery from Soroban Explorer' },
  };

  await dispatchEvent(testEvent);

  const delivery = await prismaRead.webhookDelivery.findFirst({
    where: { endpointId: req.params.id },
    orderBy: { createdAt: 'desc' },
  });

  res.json({ dispatched: true, delivery });
});

// ─── Delivery Logs ────────────────────────────────────────────────────────────

webhookRouter.get('/endpoints/:id/deliveries', async (req: Request, res: Response) => {
  const endpoint = await prismaRead.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!endpoint) return res.status(404).json({ error: 'Not found' });

  const status = req.query.status as string | undefined;
  const eventType = req.query.eventType as string | undefined;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);

  const where: Record<string, unknown> = { endpointId: req.params.id };
  if (status) where.status = status;
  if (eventType) where.eventType = eventType;

  const [deliveries, total] = await Promise.all([
    prismaRead.webhookDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prismaRead.webhookDelivery.count({ where }),
  ]);

  res.json({ data: deliveries, total, page, pages: Math.ceil(total / limit) });
});

webhookRouter.post('/endpoints/:id/deliveries/:deliveryId/retry', async (req: Request, res: Response) => {
  const delivery = await prismaRead.webhookDelivery.findFirst({
    where: { id: req.params.deliveryId, endpointId: req.params.id },
  });
  if (!delivery) return res.status(404).json({ error: 'Not found' });

  await prisma.webhookDelivery.update({
    where: { id: req.params.deliveryId },
    data: { status: 'retrying', nextRetryAt: new Date(), attempts: 0 },
  });

  res.json({ queued: true });
});

// ─── Workflows ────────────────────────────────────────────────────────────────

webhookRouter.post('/endpoints/:id/workflows', async (req: Request, res: Response) => {
  const parsed = createWorkflowSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const endpoint = await prismaRead.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!endpoint) return res.status(404).json({ error: 'Endpoint not found' });

  const workflow = await prisma.webhookWorkflow.create({
    data: { endpointId: req.params.id, ...parsed.data },
  });
  res.status(201).json(workflow);
});

webhookRouter.get('/endpoints/:id/workflows', async (req: Request, res: Response) => {
  const endpoint = await prismaRead.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!endpoint) return res.status(404).json({ error: 'Not found' });

  const workflows = await prismaRead.webhookWorkflow.findMany({
    where: { endpointId: req.params.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json(workflows);
});

webhookRouter.put('/endpoints/:id/workflows/:workflowId', async (req: Request, res: Response) => {
  const parsed = createWorkflowSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prismaRead.webhookWorkflow.findFirst({
    where: { id: req.params.workflowId, endpointId: req.params.id },
  });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const workflow = await prisma.webhookWorkflow.update({
    where: { id: req.params.workflowId },
    data: parsed.data,
  });
  res.json(workflow);
});

webhookRouter.delete('/endpoints/:id/workflows/:workflowId', async (req: Request, res: Response) => {
  const existing = await prismaRead.webhookWorkflow.findFirst({
    where: { id: req.params.workflowId, endpointId: req.params.id },
  });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await prisma.webhookWorkflow.delete({ where: { id: req.params.workflowId } });
  res.json({ deleted: true });
});

// ─── Channel Schema Reference ─────────────────────────────────────────────────

webhookRouter.get('/channels', (_req: Request, res: Response) => {
  res.json({
    channels: [
      {
        id: 'http',
        name: 'HTTP Webhook',
        configFields: [{ field: 'url', type: 'url', required: true }],
      },
      {
        id: 'slack',
        name: 'Slack',
        configFields: [{ field: 'webhookUrl', type: 'url', required: true }],
      },
      {
        id: 'discord',
        name: 'Discord',
        configFields: [{ field: 'webhookUrl', type: 'url', required: true }],
      },
      {
        id: 'telegram',
        name: 'Telegram',
        configFields: [
          { field: 'botToken', type: 'string', required: true },
          { field: 'chatId', type: 'string', required: true },
        ],
      },
      {
        id: 'email',
        name: 'Email',
        configFields: [
          { field: 'to', type: 'email', required: true },
          { field: 'subject', type: 'string', required: false },
        ],
      },
      {
        id: 'pagerduty',
        name: 'PagerDuty',
        configFields: [
          { field: 'routingKey', type: 'string', required: true },
          { field: 'severity', type: 'enum', values: ['critical', 'error', 'warning', 'info'], required: false },
        ],
      },
    ],
    filterOperators: ['eq', 'neq', 'contains', 'startsWith', 'gt', 'lt', 'in'],
    workflowStepTypes: ['delay', 'transform', 'condition', 'deliver'],
  });
});

// ─── Delivery Stats ───────────────────────────────────────────────────────────

webhookRouter.get('/endpoints/:id/stats', async (req: Request, res: Response) => {
  const endpoint = await prismaRead.webhookEndpoint.findUnique({ where: { id: req.params.id } });
  if (!endpoint) return res.status(404).json({ error: 'Not found' });

  const [total, delivered, failed, retrying, pending] = await Promise.all([
    prismaRead.webhookDelivery.count({ where: { endpointId: req.params.id } }),
    prismaRead.webhookDelivery.count({ where: { endpointId: req.params.id, status: 'delivered' } }),
    prismaRead.webhookDelivery.count({ where: { endpointId: req.params.id, status: 'failed' } }),
    prismaRead.webhookDelivery.count({ where: { endpointId: req.params.id, status: 'retrying' } }),
    prismaRead.webhookDelivery.count({ where: { endpointId: req.params.id, status: 'pending' } }),
  ]);

  const successRate = total > 0 ? ((delivered / total) * 100).toFixed(1) : '0.0';

  res.json({ endpointId: req.params.id, total, delivered, failed, retrying, pending, successRate: `${successRate}%` });
});
