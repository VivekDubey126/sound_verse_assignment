const { getDb } = require('../db/connection');
const { uuid, hashRequestBody } = require('../utils/crypto');
const { ConflictError, UnprocessableError } = require('../utils/errors');

function idempotencyMiddleware(req, res, next) {
  if (req.method !== 'POST') return next();

  const key = req.headers['idempotency-key'];
  if (!key || !req.auth) return next();

  const accountId = req.auth.accountId;
  const bodyHash = hashRequestBody(req.body);
  const db = getDb();

  const existing = db.prepare('SELECT * FROM idempotency_keys WHERE account_id = ? AND idempotency_key = ?').get(accountId, key);

  if (existing) {
    if (new Date(existing.expires_at) < new Date()) {
      db.prepare('DELETE FROM idempotency_keys WHERE id = ?').run(existing.id);
    } else {
      if (existing.request_body_hash !== bodyHash) {
        throw new UnprocessableError('idempotency_key_reuse', 'Idempotency key already used with different request body');
      }

      if (existing.locked && !existing.response_status) {
        throw new ConflictError('idempotency_key_in_progress', 'A request with this idempotency key is currently processing');
      }

      if (existing.response_status && existing.response_body) {
        res.setHeader('Idempotent-Replay', 'true');
        return res.status(existing.response_status).json(JSON.parse(existing.response_body));
      }
    }
  }

  const recordId = uuid();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86400_000).toISOString();

  try {
    db.prepare(`
      INSERT INTO idempotency_keys (id, account_id, idempotency_key, request_path, request_body_hash, locked, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(recordId, accountId, key, req.path, bodyHash, now, expiresAt);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      throw new ConflictError('idempotency_key_in_progress', 'A request with this idempotency key is currently processing');
    }
    throw err;
  }

  const originalJson = res.json.bind(res);
  res.json = function (body) {
    try {
      db.prepare(`
        UPDATE idempotency_keys SET response_status = ?, response_body = ?, locked = 0 WHERE id = ?
      `).run(res.statusCode, JSON.stringify(body), recordId);
    } catch {}
    return originalJson(body);
  };

  next();
}

module.exports = { idempotencyMiddleware };

