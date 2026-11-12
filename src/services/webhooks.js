const { getDb } = require('../db/connection');
const { uuid, generateWebhookSecret, signWebhookPayload } = require('../utils/crypto');
const { validateWebhookUrl } = require('../utils/ssrf');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const { logAudit } = require('./audit');

async function createWebhookEndpoint(accountId, url, events) {
  const ssrfError = validateWebhookUrl(url);
  if (ssrfError) {
    throw new BadRequestError('invalid_webhook_url', ssrfError);
  }

  const db = getDb();
  const secret = generateWebhookSecret();
  const endpointId = uuid();
  const now = new Date().toISOString();
  const evts = events || ['generation.completed', 'generation.failed'];

  db.prepare(`
    INSERT INTO webhook_endpoints (id, account_id, url, secret, events, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(endpointId, accountId, url, secret, JSON.stringify(evts), now, now);

  await logAudit({
    accountId,
    action: 'webhook.created',
    resourceType: 'webhook_endpoint',
    resourceId: endpointId,
    details: { url, events: evts },
  });

  const created = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(endpointId);
  return { ...created, secret_display: secret };
}

async function listWebhookEndpoints(accountId) {
  const db = getDb();
  return db.prepare('SELECT * FROM webhook_endpoints WHERE account_id = ? ORDER BY created_at DESC').all(accountId);
}

async function deleteWebhookEndpoint(accountId, endpointId) {
  const db = getDb();
  const endpoint = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ? AND account_id = ?').get(endpointId, accountId);
  if (!endpoint) throw new NotFoundError('Webhook endpoint');

  db.prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(endpointId);
}

async function queueWebhookDeliveries(generation, eventType) {
  const db = getDb();
  const endpoints = db.prepare('SELECT * FROM webhook_endpoints WHERE account_id = ? AND is_active = 1').all(generation.account_id);

  for (const ep of endpoints) {
    const events = JSON.parse(ep.events || '[]');
    if (!events.includes(eventType)) continue;

    const payload = JSON.stringify({
      id: uuid(),
      type: eventType,
      created_at: new Date().toISOString(),
      data: {
        generation_id: generation.id,
        status: generation.status,
        license: generation.license,
        credits_charged: generation.credits_charged,
        model: generation.model,
      },
    });

    db.prepare(`
      INSERT INTO webhook_deliveries (id, webhook_endpoint_id, generation_id, event_type, payload, attempt, max_attempts, next_retry_at, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 5, ?, ?)
    `).run(uuid(), ep.id, generation.id, eventType, payload, new Date().toISOString(), new Date().toISOString());
  }
}

async function deliverWebhook(delivery) {
  const db = getDb();
  const ep = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(delivery.webhook_endpoint_id);
  if (!ep || !ep.is_active) return;

  const timestamp = Math.floor(Date.now() / 1000);
  const sig = signWebhookPayload(delivery.payload, ep.secret, timestamp);

  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `t=${timestamp},v1=${sig}`,
        'X-Webhook-Id': delivery.id,
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(5000),
    });

    db.prepare('UPDATE webhook_deliveries SET delivered_at = ?, response_status = ?, next_retry_at = NULL WHERE id = ?')
      .run(new Date().toISOString(), res.status, delivery.id);
  } catch (err) {
    const nextAttempt = delivery.attempt + 1;
    if (nextAttempt >= delivery.max_attempts) {
      db.prepare('UPDATE webhook_deliveries SET attempt = ?, next_retry_at = NULL, response_body = ? WHERE id = ?')
        .run(nextAttempt, err.message, delivery.id);
    } else {
      const delaySec = 10 * Math.pow(3, nextAttempt - 1);
      const nextDate = new Date(Date.now() + delaySec * 1000).toISOString();
      db.prepare('UPDATE webhook_deliveries SET attempt = ?, next_retry_at = ?, response_body = ? WHERE id = ?')
        .run(nextAttempt, nextDate, err.message, delivery.id);
    }
  }
}

module.exports = {
  createWebhookEndpoint,
  listWebhookEndpoints,
  deleteWebhookEndpoint,
  queueWebhookDeliveries,
  deliverWebhook,
};

