import crypto from 'crypto';
import { prismaWrite as prisma } from '../db';
import { processResponseBody } from './redaction';
import { assertSafeUrl, safePost, SsrfBlockedError } from './ssrf-guard';

// Maximum delivery attempts before a delivery is marked permanently failed
export const MAX_ATTEMPTS = 5;
// Hard timeout per HTTP request (ms)
export const REQUEST_TIMEOUT_MS = 10_000;
// How long a processing lease is held before it is considered stale (ms)
export const LEASE_DURATION_MS = 60_000;

/** Compute exponential backoff delay for a given attempt (1-based). */
export function backoffMs(attempt: number): number {
  // 10s, 30s, 90s, 270s, 810s — capped at 15 min
  return Math.min(10_000 * 3 ** (attempt - 1), 900_000);
}

export interface WebhookPayload {
  id: string;
  contractAddress: string;
  eventType: string;
  topicSymbol?: string | null;
  decoded: unknown;
  ledger: number;
  ledgerCloseTime: Date;
  transactionHash: string;
}

/**
 * Fan-out a single event to all matching active webhook subscriptions.
 * Each delivery is persisted and dispatched immediately (attempt 1).
 */
export async function dispatchWebhooks(event: WebhookPayload): Promise<void> {
  const subs = await prisma.webhookSubscription.findMany({
    where: {
      active: true,
      ...(event.contractAddress && {
        OR: [{ contractAddress: null }, { contractAddress: event.contractAddress }],
      }),
    },
    select: {
      id: true,
      url: true,
      secret: true,
      eventType: true,
      topicSymbol: true,
      storeResponseBody: true,
      responseRetentionDays: true,
    },
  });

  const matching = subs.filter((s) => {
    if (s.eventType && s.eventType !== event.eventType) return false;
    if (s.topicSymbol && s.topicSymbol !== event.topicSymbol) return false;
    return true;
  });

  await Promise.all(
    matching.map((sub) =>
      deliverOnce(
        sub.id,
        sub.url,
        sub.secret,
        event,
        1,
        undefined,
        sub.storeResponseBody,
        sub.responseRetentionDays,
      ),
    ),
  );
}

/**
 * Retry all pending deliveries whose nextRetryAt is due.
 * Rows are claimed atomically with a processing lease so that concurrent
 * service replicas cannot pick up the same delivery twice.
 *
 * Call this on a periodic schedule (e.g. every 30s from the indexer).
 */
export async function retryPendingDeliveries(): Promise<void> {
  const now = new Date();
  const leaseExpiry = new Date(now.getTime() + LEASE_DURATION_MS);

  // Atomically claim a batch of due deliveries that are currently idle.
  // The UPDATE … WHERE … prevents two replicas from claiming the same row
  // because the second writer will find processingStatus != 'idle' and skip it.
  const claimed = await prisma.$transaction(async (tx) => {
    const rows = await tx.webhookDelivery.findMany({
      where: {
        status: 'pending',
        nextRetryAt: { lte: now },
        OR: [
          { processingStatus: 'idle' },
          // Re-claim rows whose lease has expired (e.g. the previous worker crashed)
          { processingStatus: 'processing', leaseExpiresAt: { lte: now } },
        ],
      },
      select: { id: true },
    });

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);

    // Mark all selected rows as "processing" in one query — rows already
    // taken by another replica (processingStatus changed since the findMany)
    // are simply skipped by the WHERE predicate, so no double-delivery occurs.
    await tx.webhookDelivery.updateMany({
      where: {
        id: { in: ids },
        OR: [
          { processingStatus: 'idle' },
          { processingStatus: 'processing', leaseExpiresAt: { lte: now } },
        ],
      },
      data: { processingStatus: 'processing', leaseExpiresAt: leaseExpiry },
    });

    // Re-fetch only the rows we successfully claimed
    return tx.webhookDelivery.findMany({
      where: { id: { in: ids }, processingStatus: 'processing', leaseExpiresAt: leaseExpiry },
      include: {
        subscription: {
          select: {
            url: true,
            secret: true,
            active: true,
            storeResponseBody: true,
            responseRetentionDays: true,
          },
        },
      },
    });
  });

  await Promise.all(
    claimed.map((d) => {
      // Skip deliveries for inactive subscriptions
      if (!d.subscription.active) {
        return prisma.webhookDelivery.update({
          where: { id: d.id },
          data: { status: 'cancelled', processingStatus: 'done', leaseExpiresAt: null },
        });
      }

      return deliverOnce(
        d.subscriptionId,
        d.subscription.url,
        d.subscription.secret,
        null,
        d.attempt ?? 1,
        d.id,
        d.subscription.storeResponseBody,
        d.subscription.responseRetentionDays,
      );
    }),
  );
}

/**
 * Perform a single HTTP delivery attempt.
 * Validates the destination URL against SSRF rules before every request,
 * including on each redirect hop.
 *
 * @param deliveryId  If provided, updates an existing delivery row; otherwise creates one.
 */
async function deliverOnce(
  subscriptionId: string,
  url: string,
  secret: string | null,
  event: WebhookPayload | null,
  attempt: number,
  deliveryId?: string,
  storeResponseBody: boolean = true,
  responseRetentionDays: number = 90,
): Promise<void> {
  let payload: WebhookPayload | null = event;
  let eventId = event?.id ?? '';

  if (!payload && deliveryId) {
    const row = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!row) return;
    eventId = row.eventId ?? '';
    // Re-fetch the event to rebuild the payload
    const ev = await prisma.event.findUnique({ where: { id: eventId } });
    if (!ev) return;
    payload = {
      id: ev.id,
      contractAddress: ev.contractAddress,
      eventType: ev.eventType,
      topicSymbol: ev.topicSymbol,
      decoded: ev.decoded,
      ledger: ev.ledgerSequence,
      ledgerCloseTime: ev.ledgerCloseTime,
      transactionHash: ev.transactionHash,
    };
  }

  if (!payload) return;

  // Pre-flight SSRF check: validate URL and resolve DNS before opening a
  // socket.  safePost() will re-validate on every redirect hop as well.
  try {
    await assertSafeUrl(url);
  } catch (err) {
    const msg = err instanceof SsrfBlockedError ? err.message : String(err);
    // Permanently fail — retrying a blocked URL will never succeed.
    if (deliveryId) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'failed',
          processingStatus: 'done',
          leaseExpiresAt: null,
          errorMsg: msg,
          nextRetryAt: null,
        },
      });
    }
    return;
  }

  const body = JSON.stringify({ event: payload, attempt });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (secret) {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
  }

  const expiresAt = new Date(Date.now() + responseRetentionDays * 24 * 60 * 60 * 1000);

  // Create or update the delivery row to "pending" before attempting.
  // For new deliveries (no deliveryId) we start with processingStatus='processing'
  // so the retry loop cannot also pick it up while the initial attempt is in-flight.
  const delivery = deliveryId
    ? await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { attempt, status: 'pending', nextRetryAt: null },
      })
    : await prisma.webhookDelivery.create({
        data: {
          subscriptionId,
          eventId,
          attempt,
          status: 'pending',
          processingStatus: 'processing',
          leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS),
          expiresAt,
        },
      });

  try {
    // safePost validates the URL (and every redirect target) before sending
    const response = await safePost(url, body, headers, REQUEST_TIMEOUT_MS);

    const success = response.status >= 200 && response.status < 300;
    const rawResponseBody = String(response.data ?? '');

    if (success) {
      const processedResponseBody = storeResponseBody
        ? processResponseBody(rawResponseBody, 500, true)
        : null;

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'success',
          processingStatus: 'done',
          leaseExpiresAt: null,
          httpStatus: response.status,
          responseBody: processedResponseBody,
          deliveredAt: new Date(),
        },
      });
      return;
    }

    const processedResponseBody = storeResponseBody
      ? processResponseBody(rawResponseBody, 500, true)
      : null;

    await scheduleRetryOrFail(
      delivery.id,
      attempt,
      `HTTP ${response.status}`,
      response.status,
      processedResponseBody,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // SSRF blocks on redirect are permanent failures — don't retry
    if (err instanceof SsrfBlockedError) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'failed',
          processingStatus: 'done',
          leaseExpiresAt: null,
          errorMsg: msg,
          nextRetryAt: null,
        },
      });
      return;
    }

    const processedError = storeResponseBody ? processResponseBody(msg, 500, true) : null;
    await scheduleRetryOrFail(delivery.id, attempt, msg, undefined, processedError);
  }
}

async function scheduleRetryOrFail(
  deliveryId: string,
  attempt: number,
  errorMsg: string,
  httpStatus?: number,
  responseBody?: string,
): Promise<void> {
  const nextAttempt = attempt + 1;

  if (nextAttempt > MAX_ATTEMPTS) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'failed',
        processingStatus: 'done',
        leaseExpiresAt: null,
        errorMsg,
        httpStatus,
        responseBody,
        nextRetryAt: null,
      },
    });
    return;
  }

  const nextRetryAt = new Date(Date.now() + backoffMs(nextAttempt));
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: 'pending',
      processingStatus: 'idle',
      leaseExpiresAt: null,
      errorMsg,
      httpStatus,
      responseBody,
      nextRetryAt,
      attempt: nextAttempt,
    },
  });
}
