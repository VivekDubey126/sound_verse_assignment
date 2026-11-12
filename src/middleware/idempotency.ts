import { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/connection';
import { uuid } from '../utils/ids';
import { hashRequestBody } from '../utils/crypto';
import { ConflictError, UnprocessableError } from '../utils/errors';
import type { IdempotencyRecord } from '../types';

/**
 * Idempotency middleware for POST requests.
 *
 * If the client sends an Idempotency-Key header:
 * 1. If the key exists and body hash matches → return cached response
 * 2. If the key exists and body hash differs → 422 error
 * 3. If the key exists and is still being processed (locked) → 409 conflict
 * 4. If the key doesn't exist → create entry, proceed, cache response
 *
 * Keys expire after 24 hours.
 */
export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Only applies to POST requests with the header
  if (req.method !== 'POST') {
    return next();
  }

  const idempotencyKey = req.headers['idempotency-key'] as string;
  if (!idempotencyKey) {
    return next();
  }

  if (!req.auth) {
    return next();
  }

  const accountId = req.auth.accountId;
  const bodyHash = hashRequestBody(req.body);
  const db = getDb();

  try {
    // Check for existing idempotency record
    const existing = await db<IdempotencyRecord>('idempotency_keys')
      .where('account_id', accountId)
      .where('idempotency_key', idempotencyKey)
      .first();

    if (existing) {
      // Check if expired
      if (new Date(existing.expires_at) < new Date()) {
        // Expired — delete and proceed as new
        await db('idempotency_keys').where('id', existing.id).delete();
      } else {
        // Check body hash match
        if (existing.request_body_hash !== bodyHash) {
          throw new UnprocessableError(
            'idempotency_key_reuse',
            'Idempotency key has already been used with a different request body'
          );
        }

        // If still being processed (locked), return 409
        if (existing.locked && !existing.response_status) {
          throw new ConflictError(
            'idempotency_key_in_progress',
            'A request with this idempotency key is currently being processed'
          );
        }

        // If we have a cached response, return it
        if (existing.response_status && existing.response_body) {
          res.status(existing.response_status).json(JSON.parse(existing.response_body));
          return;
        }
      }
    }

    // Create new idempotency record (locked)
    const record: Partial<IdempotencyRecord> = {
      id: uuid(),
      account_id: accountId,
      idempotency_key: idempotencyKey,
      request_path: req.path,
      request_body_hash: bodyHash,
      locked: 1,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    try {
      await db('idempotency_keys').insert(record);
    } catch (err: any) {
      // Unique constraint violation — another request with same key is being processed
      if (err.message?.includes('UNIQUE') || err.code === '23505') {
        throw new ConflictError(
          'idempotency_key_in_progress',
          'A request with this idempotency key is currently being processed'
        );
      }
      throw err;
    }

    // Store the idempotency record ID for later response caching
    (req as any)._idempotencyRecordId = record.id;

    // Intercept res.json to cache the response
    const originalJson = res.json.bind(res);
    res.json = function (body: any) {
      // Cache the response asynchronously
      db('idempotency_keys')
        .where('id', record.id)
        .update({
          response_status: res.statusCode,
          response_body: JSON.stringify(body),
          locked: 0,
        })
        .catch((err) => console.error('[IDEMPOTENCY] Failed to cache response:', err));

      return originalJson(body);
    };

    next();
  } catch (err) {
    next(err);
  }
}

