const { getDb } = require('../db/connection');
const { uuid, generateApiKey } = require('../utils/crypto');
const { NotFoundError, BadRequestError } = require('../utils/errors');
const { logAudit } = require('./audit');

function toPublic(k) {
  return {
    id: k.id,
    key_prefix: k.key_prefix,
    name: k.name,
    mode: k.mode,
    scopes: JSON.parse(k.scopes || '[]'),
    is_revoked: Boolean(k.is_revoked),
    last_used_at: k.last_used_at,
    created_at: k.created_at,
  };
}

async function createApiKey(opts, actorId, ipAddress) {
  const db = getDb();
  const scopes = opts.scopes || ['generations:write', 'generations:read'];
  const { fullKey, prefix, hash } = generateApiKey(opts.mode);

  const keyId = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO api_keys (id, account_id, key_prefix, key_hash, name, mode, scopes, is_revoked, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
  `).run(keyId, opts.accountId, prefix, hash, opts.name || null, opts.mode, JSON.stringify(scopes), now);

  await logAudit({
    accountId: opts.accountId,
    actorType: 'user',
    actorId: actorId || opts.accountId,
    action: 'api_key.created',
    resourceType: 'api_key',
    resourceId: keyId,
    details: { mode: opts.mode, prefix, scopes },
    ipAddress,
  });

  const created = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
  return { key: toPublic(created), secret: fullKey };
}

async function listApiKeys(accountId) {
  const db = getDb();
  const keys = db.prepare('SELECT * FROM api_keys WHERE account_id = ? ORDER BY created_at DESC').all(accountId);
  return keys.map(toPublic);
}

async function revokeApiKey(accountId, keyId, actorId, ipAddress) {
  const db = getDb();
  const key = db.prepare('SELECT * FROM api_keys WHERE id = ? AND account_id = ?').get(keyId, accountId);
  if (!key) throw new NotFoundError('API key');

  db.prepare('UPDATE api_keys SET is_revoked = 1 WHERE id = ?').run(keyId);

  await logAudit({
    accountId,
    actorType: 'user',
    actorId: actorId || accountId,
    action: 'api_key.revoked',
    resourceType: 'api_key',
    resourceId: keyId,
    details: { prefix: key.key_prefix },
    ipAddress,
  });

  return toPublic({ ...key, is_revoked: 1 });
}

async function rotateApiKey(accountId, oldKeyId, actorId, ipAddress) {
  const db = getDb();
  const oldKey = db.prepare('SELECT * FROM api_keys WHERE id = ? AND account_id = ?').get(oldKeyId, accountId);
  if (!oldKey) throw new NotFoundError('API key');
  if (oldKey.is_revoked) throw new BadRequestError('key_already_revoked', 'Cannot rotate a revoked key');

  const result = await createApiKey({
    accountId,
    name: oldKey.name ? `${oldKey.name} (rotated)` : undefined,
    mode: oldKey.mode,
    scopes: JSON.parse(oldKey.scopes || '[]'),
  }, actorId, ipAddress);

  await revokeApiKey(accountId, oldKeyId, actorId, ipAddress);

  return result;
}

module.exports = { createApiKey, listApiKeys, revokeApiKey, rotateApiKey };

