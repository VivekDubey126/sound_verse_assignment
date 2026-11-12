const { getDb } = require('../db/connection');
const { uuid } = require('../utils/crypto');

async function logAudit(opts) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (id, account_id, actor_type, actor_id, action, resource_type, resource_id, details, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      opts.accountId,
      opts.actorType || 'user',
      opts.actorId || null,
      opts.action,
      opts.resourceType,
      opts.resourceId || null,
      JSON.stringify(opts.details || {}),
      opts.ipAddress || null,
      new Date().toISOString()
    );
  } catch (e) {
    console.error('[AUDIT ERROR]', e.message);
  }
}

async function getAuditLog(accountId, opts = {}) {
  const db = getDb();
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;
  return db.prepare('SELECT * FROM audit_log WHERE account_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(accountId, limit, offset);
}

module.exports = { logAudit, getAuditLog };

