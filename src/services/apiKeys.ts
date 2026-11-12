import { getDb } from '../db/connection';
import { uuid } from '../utils/ids';
import { generateApiKey } from '../utils/crypto';
import { NotFoundError, BadRequestError } from '../utils/errors';
import { logAudit } from './audit';
import type { ApiKey } from '../types';

export interface CreateKeyOptions {
  accountId: string;
  name?: string;
  mode: 'test' | 'live';
  scopes?: string[];
}

export interface ApiKeyPublic {
  id: string;
  key_prefix: string;
  name: string | null;
  mode: string;
  scopes: string[];
  is_revoked: boolean;
  last_used_at: string | null;
  created_at: string;
}

function toPublic(key: ApiKey): ApiKeyPublic {
  return {
    id: key.id,
    key_prefix: key.key_prefix,
    name: key.name,
    mode: key.mode,
    scopes: JSON.parse(key.scopes),
    is_revoked: !!key.is_revoked,
    last_used_at: key.last_used_at,
    created_at: key.created_at,
  };
}

/**
 * Create a new API key. Returns the full secret exactly once.
 */
export async function createApiKey(
  opts: CreateKeyOptions,
  actorId?: string,
  ipAddress?: string
): Promise<{ key: ApiKeyPublic; secret: string }> {
  const db = getDb();

  const scopes = opts.scopes || ['generations:write', 'generations:read'];
  const { fullKey, prefix, hash } = generateApiKey(opts.mode);

  const keyRecord: ApiKey = {
    id: uuid(),
    account_id: opts.accountId,
    key_prefix: prefix,
    key_hash: hash,
    name: opts.name || null,
    mode: opts.mode,
    scopes: JSON.stringify(scopes),
    is_revoked: 0,
    last_used_at: null,
    created_at: new Date().toISOString(),
  };

  await db('api_keys').insert(keyRecord);

  await logAudit({
    accountId: opts.accountId,
    actorType: 'user',
    actorId: actorId || opts.accountId,
    action: 'api_key.created',
    resourceType: 'api_key',
    resourceId: keyRecord.id,
    details: { mode: opts.mode, prefix, scopes },
    ipAddress,
  });

  return {
    key: toPublic(keyRecord),
    secret: fullKey,
  };
}

/**
 * List all API keys for an account (never includes hash or secret).
 */
export async function listApiKeys(accountId: string): Promise<ApiKeyPublic[]> {
  const db = getDb();
  const keys = await db<ApiKey>('api_keys')
    .where('account_id', accountId)
    .orderBy('created_at', 'desc');
  return keys.map(toPublic);
}

/**
 * Revoke an API key. It will fail on its very next request.
 */
export async function revokeApiKey(
  accountId: string,
  keyId: string,
  actorId?: string,
  ipAddress?: string
): Promise<ApiKeyPublic> {
  const db = getDb();

  const key = await db<ApiKey>('api_keys')
    .where('id', keyId)
    .where('account_id', accountId)
    .first();

  if (!key) {
    throw new NotFoundError('API key');
  }

  if (key.is_revoked) {
    return toPublic(key); // Already revoked, idempotent
  }

  await db('api_keys').where('id', keyId).update({ is_revoked: 1 });

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

/**
 * Rotate an API key: create a new key, then revoke the old one.
 * Both keys are valid during the transition (between create and revoke).
 * Returns the new key's secret.
 */
export async function rotateApiKey(
  accountId: string,
  oldKeyId: string,
  actorId?: string,
  ipAddress?: string
): Promise<{ key: ApiKeyPublic; secret: string }> {
  const db = getDb();

  const oldKey = await db<ApiKey>('api_keys')
    .where('id', oldKeyId)
    .where('account_id', accountId)
    .first();

  if (!oldKey) {
    throw new NotFoundError('API key');
  }

  if (oldKey.is_revoked) {
    throw new BadRequestError('key_already_revoked', 'Cannot rotate a revoked key');
  }

  // Create new key with same mode and scopes
  const result = await createApiKey(
    {
      accountId,
      name: oldKey.name ? `${oldKey.name} (rotated)` : undefined,
      mode: oldKey.mode as 'test' | 'live',
      scopes: JSON.parse(oldKey.scopes),
    },
    actorId,
    ipAddress
  );

  // Revoke old key
  await revokeApiKey(accountId, oldKeyId, actorId, ipAddress);

  await logAudit({
    accountId,
    actorType: 'user',
    actorId: actorId || accountId,
    action: 'api_key.rotated',
    resourceType: 'api_key',
    resourceId: oldKeyId,
    details: { old_prefix: oldKey.key_prefix, new_key_id: result.key.id },
    ipAddress,
  });

  return result;
}

