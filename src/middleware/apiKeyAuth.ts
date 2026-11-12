import { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/connection';
import { hashApiKey } from '../utils/crypto';
import { AuthenticationError, ForbiddenError } from '../utils/errors';
import type { ApiKey, Account, Plan } from '../types';

/**
 * API key authentication middleware.
 * Expects Authorization: Bearer sk_{mode}_{secret}
 *
 * Validates the key, checks revocation, updates last_used_at,
 * and attaches the full auth context to the request.
 */
export function apiKeyAuth(...requiredScopes: string[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AuthenticationError('Missing or invalid Authorization header');
      }

      const rawKey = authHeader.slice(7).trim();

      // Validate key format
      if (!rawKey.startsWith('sk_test_') && !rawKey.startsWith('sk_live_')) {
        throw new AuthenticationError('Invalid API key format');
      }

      const keyHash = hashApiKey(rawKey);
      const db = getDb();

      // Look up by hash
      const apiKey = await db<ApiKey>('api_keys').where('key_hash', keyHash).first();
      if (!apiKey) {
        throw new AuthenticationError('Invalid API key');
      }

      // Check revocation — a revoked key fails immediately
      if (apiKey.is_revoked) {
        throw new AuthenticationError('API key has been revoked');
      }

      // Check required scopes
      const keyScopes: string[] = JSON.parse(apiKey.scopes);
      for (const scope of requiredScopes) {
        if (!keyScopes.includes(scope)) {
          throw new ForbiddenError('insufficient_scope', `API key lacks required scope: ${scope}`);
        }
      }

      // Load account and plan
      const account = await db<Account>('accounts').where('id', apiKey.account_id).first();
      if (!account) {
        throw new AuthenticationError('Account not found');
      }

      if (!account.email_verified) {
        throw new ForbiddenError('email_not_verified', 'Please verify your email before using the API');
      }

      const plan = await db<Plan>('plans').where('name', account.plan_name).first();
      if (!plan) {
        throw new AuthenticationError('Account plan not found');
      }

      // Update last_used_at (fire and forget)
      db('api_keys')
        .where('id', apiKey.id)
        .update({ last_used_at: new Date().toISOString() })
        .catch(() => {}); // non-critical

      // Attach context
      req.auth = {
        accountId: account.id,
        account,
        plan,
      };
      req.apiKeyCtx = {
        accountId: account.id,
        account,
        plan,
        apiKey,
        keyMode: apiKey.mode as 'test' | 'live',
        scopes: keyScopes,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

