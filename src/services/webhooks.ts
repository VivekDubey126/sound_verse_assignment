import { getDb } from '../db/connection';
import { uuid } from '../utils/ids';
import { generateWebhookSecret, signWebhookPayload } from '../utils/crypto';
import { validateWebhookUrl } from '../utils/ssrf';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { logAudit } from './audit';
import type { WebhookEndpoint, WebhookDelivery, Generation } from '../types';

const VALID_EVENTS = ['generation.completed', 'generation.failed'];

/**
 * Create a webhook endpoint.
 */
export async function createWebhookEndpoint(
  accountId: string,
  url: string,
  events?: string[]
): Promise<WebhookEndpoint & { secret_display: string }> {
  const db = getDb();

  // SSRF validation
  const ssrfError = validateWebhookUrl(url);
  if (ssrfError) {
    throw new BadRequestError('invalid_webhook_url', ssrfError);
  }

  // Validate events
  const evts = events || VALID_EVENTS;
  for (const evt of evts) {
    if (!VALID_EVENTS.includes(evt)) {
      throw new BadRequestError('invalid_event', `Invalid event type: ${evt}. Valid: ${VALID_EVENTS.join(', ')}`);
    }
  }

  const secret = generateWebhookSecret();
  const now = new Date().toISOString();

  const endpoint: WebhookEndpoint = {
    id: uuid(),
    account_id: accountId,
    url,
    secret,
    events: JSON.stringify(evts),
    is_active: 1,
    created_at: now,
    updated_at: now,
  };

  await db('webhook_endpoints').insert(endpoint);

  await logAudit({
    accountId,
    actorType: 'user',
    actorId: accountId,
    action: 'webhook.created',
    resourceType: 'webhook_endpoint',
    resourceId: endpoint.id,
    details: { url, events: evts },
  });

  return { ...endpoint, secret_display: secret };
}

/**
 * List webhook endpoints for an account.
 */
export async function listWebhookEndpoints(accountId: string): Promise<WebhookEndpoint[]> {
  const db = getDb();
  return db<WebhookEndpoint>('webhook_endpoints')
    .where('account_id', accountId)
    .orderBy('created_at', 'desc');
}

/**
 * Get a webhook endpoint by ID.
 */
export async function getWebhookEndpoint(accountId: string, endpointId: string): Promise<WebhookEndpoint> {
  const db = getDb();
  const endpoint = await db<WebhookEndpoint>('webhook_endpoints')
    .where('id', endpointId)
    .where('account_id', accountId)
    .first();

  if (!endpoint) {
    throw new NotFoundError('Webhook endpoint');
  }

  return endpoint;
}

/**
 * Delete a webhook endpoint.
 */
export async function deleteWebhookEndpoint(accountId: string, endpointId: string): Promise<void> {
  const db = getDb();

  const endpoint = await db<WebhookEndpoint>('webhook_endpoints')
    .where('id', endpointId)
    .where('account_id', accountId)
    .first();

  if (!endpoint) {
    throw new NotFoundError('Webhook endpoint');
  }

  await db('webhook_endpoints').where('id', endpointId).delete();

  await logAudit({
    accountId,
    actorType: 'user',
    actorId: accountId,
    action: 'webhook.deleted',
    resourceType: 'webhook_endpoint',
    resourceId: endpointId,
    details: { url: endpoint.url },
  });
}

/**
 * Queue webhook deliveries for a generation event.
 * Called by the generation worker when a job completes or fails.
 */
export async function queueWebhookDeliveries(generation: Generation, eventType: string): Promise<void> {
  const db = getDb();

  // Find active endpoints for this account that subscribe to this event
  const endpoints = await db<WebhookEndpoint>('webhook_endpoints')
    .where('account_id', generation.account_id)
    .where('is_active', 1);

  for (const endpoint of endpoints) {
    const events: string[] = JSON.parse(endpoint.events);
    if (!events.includes(eventType)) continue;

    const payload = {
      id: uuid(),
      type: eventType,
      created_at: new Date().toISOString(),
      data: {
        generation_id: generation.id,
        status: generation.status,
        license: generation.license,
        credits_charged: generation.credits_charged,
        model: generation.model,
        error: generation.error_message,
        completed_at: generation.completed_at,
      },
    };

    const delivery: Partial<WebhookDelivery> = {
      id: uuid(),
      webhook_endpoint_id: endpoint.id,
      generation_id: generation.id,
      event_type: eventType,
      payload: JSON.stringify(payload),
      response_status: null,
      response_body: null,
      attempt: 0,
      max_attempts: 5,
      next_retry_at: new Date().toISOString(), // Deliver immediately
      delivered_at: null,
      created_at: new Date().toISOString(),
    };

    await db('webhook_deliveries').insert(delivery);
  }
}

/**
 * Attempt to deliver a webhook.
 * Returns true if delivered successfully.
 */
export async function deliverWebhook(delivery: WebhookDelivery): Promise<boolean> {
  const db = getDb();

  const endpoint = await db<WebhookEndpoint>('webhook_endpoints')
    .where('id', delivery.webhook_endpoint_id)
    .first();

  if (!endpoint || !endpoint.is_active) {
    return false;
  }

  // SSRF re-check (URL could have been modified)
  const ssrfError = validateWebhookUrl(endpoint.url);
  if (ssrfError) {
    console.warn(`[WEBHOOK] Skipping delivery ${delivery.id}: SSRF blocked URL ${endpoint.url}`);
    await db('webhook_deliveries').where('id', delivery.id).update({
      attempt: delivery.attempt + 1,
      response_body: `Blocked: ${ssrfError}`,
      next_retry_at: null, // Don't retry SSRF-blocked URLs
    });
    return false;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(delivery.payload, endpoint.secret, timestamp);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `t=${timestamp},v1=${signature}`,
        'X-Webhook-Id': delivery.id,
        'User-Agent': 'Soundverse-Webhooks/1.0',
      },
      body: delivery.payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const responseBody = await response.text().catch(() => '');

    if (response.ok) {
      await db('webhook_deliveries').where('id', delivery.id).update({
        attempt: delivery.attempt + 1,
        response_status: response.status,
        response_body: responseBody.slice(0, 1000),
        delivered_at: new Date().toISOString(),
        next_retry_at: null,
      });
      return true;
    }

    // Non-2xx response — schedule retry
    await scheduleRetry(delivery, response.status, responseBody);
    return false;
  } catch (err: any) {
    // Network error — schedule retry
    await scheduleRetry(delivery, null, err.message);
    return false;
  }
}

async function scheduleRetry(delivery: WebhookDelivery, status: number | null, responseBody: string): Promise<void> {
  const db = getDb();
  const nextAttempt = delivery.attempt + 1;

  if (nextAttempt >= delivery.max_attempts) {
    // Max retries reached
    await db('webhook_deliveries').where('id', delivery.id).update({
      attempt: nextAttempt,
      response_status: status,
      response_body: (responseBody || '').slice(0, 1000),
      next_retry_at: null,
    });
    return;
  }

  // Exponential backoff: 10s, 30s, 90s, 270s, 810s
  const delaySec = 10 * Math.pow(3, nextAttempt - 1);
  const nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString();

  await db('webhook_deliveries').where('id', delivery.id).update({
    attempt: nextAttempt,
    response_status: status,
    response_body: (responseBody || '').slice(0, 1000),
    next_retry_at: nextRetryAt,
  });
}

