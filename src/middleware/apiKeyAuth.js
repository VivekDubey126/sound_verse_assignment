const { getDb } = require('../db/connection');
const { hashApiKey } = require('../utils/crypto');
const { AuthenticationError, ForbiddenError } = require('../utils/errors');

function apiKeyAuth(...requiredScopes) {
  return (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AuthenticationError('Missing or invalid Authorization header');
      }

      const rawKey = authHeader.slice(7).trim();
      if (!rawKey.startsWith('sk_test_') && !rawKey.startsWith('sk_live_')) {
        throw new AuthenticationError('Invalid API key format');
      }

      const keyHash = hashApiKey(rawKey);
      const db = getDb();
      const apiKey = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash);

      if (!apiKey) throw new AuthenticationError('Invalid API key');
      if (apiKey.is_revoked) throw new AuthenticationError('API key has been revoked');

      const scopes = JSON.parse(apiKey.scopes || '[]');
      for (const s of requiredScopes) {
        if (!scopes.includes(s)) {
          throw new ForbiddenError('insufficient_scope', `API key lacks scope: ${s}`);
        }
      }

      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(apiKey.account_id);
      if (!account) throw new AuthenticationError('Account not found');

      const plan = db.prepare('SELECT * FROM plans WHERE name = ?').get(account.plan_name);
      if (!plan) throw new AuthenticationError('Plan not found');

      // Update last_used_at timestamp on every valid request
      try {
        db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), apiKey.id);
      } catch {}

      req.auth = { accountId: account.id, account, plan };
      req.apiKeyCtx = {
        accountId: account.id,
        account,
        plan,
        apiKey,
        keyMode: apiKey.mode,
        scopes,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { apiKeyAuth };

