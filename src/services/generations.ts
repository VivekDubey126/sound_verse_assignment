import { getDb } from '../db/connection';
import { generateId, uuid } from '../utils/ids';
import { generateSignedUrl } from '../utils/crypto';
import { accountLock } from '../utils/lock';
import { checkAndReserveCredits } from './metering';
import { NotFoundError, RateLimitError, ForbiddenError, BadRequestError } from '../utils/errors';
import type { Generation, Plan, GenerationResponse } from '../types';

/**
 * Format a generation row into the API response shape.
 */
export function formatGeneration(gen: Generation): GenerationResponse {
  return {
    id: gen.id,
    status: gen.status,
    license: gen.license,
    credits_charged: gen.credits_charged,
    prompt: gen.prompt,
    duration_sec: gen.duration_sec,
    instrumental: !!gen.instrumental,
    metadata: JSON.parse(gen.metadata || '{}'),
    output: gen.status === 'succeeded' && gen.output_url
      ? {
          audio_url: generateSignedUrl(gen.id),
          duration_sec: gen.output_duration_sec,
          format: gen.output_format || 'mp3',
        }
      : null,
    model: gen.model,
    created_at: gen.created_at,
    started_at: gen.started_at,
    completed_at: gen.completed_at,
  };
}

/**
 * Create a new generation job.
 *
 * This is the critical path that must be concurrency-safe:
 * 1. Check parallel generation limit
 * 2. Check and reserve credits
 * 3. Create the generation record
 *
 * All three checks are serialized per-account via AccountLock.
 */
export async function createGeneration(opts: {
  accountId: string;
  apiKeyId: string;
  prompt: string;
  durationSec: number;
  license: string;
  instrumental: boolean;
  metadata: Record<string, any>;
  plan: Plan;
  isTestKey: boolean;
  idempotencyKey?: string;
}): Promise<Generation> {
  const db = getDb();

  // Entire check-and-create is serialized per account
  return accountLock.acquire(opts.accountId, async () => {
    // 1. Check parallel generation limit
    const activeJobs = await db<Generation>('generations')
      .where('account_id', opts.accountId)
      .whereIn('status', ['queued', 'running'])
      .count('id as count')
      .first();

    const activeCount = Number((activeJobs as any)?.count || 0);

    if (activeCount >= opts.plan.parallel_generations) {
      throw new RateLimitError(
        'parallel_limit_reached',
        `Parallel generation limit reached: ${activeCount}/${opts.plan.parallel_generations} jobs active. Wait for a job to complete or cancel one.`
      );
    }

    // 2. Validate license against plan
    const availableLicenses: string[] = JSON.parse(opts.plan.licenses_available);
    if (!availableLicenses.includes(opts.license)) {
      throw new ForbiddenError(
        'license_not_available',
        `License '${opts.license}' is not available on the ${opts.plan.display_name} plan. Available: ${availableLicenses.join(', ')}`
      );
    }

    // 3. Generate ID
    const genId = generateId('gen');

    // 4. Check and reserve credits (inside the lock)
    const creditsCharged = await checkAndReserveCredits(
      opts.accountId,
      opts.apiKeyId,
      genId,
      opts.license,
      opts.durationSec,
      opts.plan,
      opts.isTestKey
    );

    // 5. Determine model
    const model = opts.isTestKey ? 'mock/test-v1' : 'provider/music-v1';

    // 6. Create generation record
    const generation: Generation = {
      id: genId,
      account_id: opts.accountId,
      api_key_id: opts.apiKeyId,
      prompt: opts.prompt,
      duration_sec: opts.durationSec,
      license: opts.license,
      instrumental: opts.instrumental ? 1 : 0,
      metadata: JSON.stringify(opts.metadata || {}),
      status: 'queued',
      model,
      credits_charged: creditsCharged,
      output_url: null,
      output_duration_sec: null,
      output_format: 'mp3',
      error_message: null,
      idempotency_key: opts.idempotencyKey || null,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };

    await db('generations').insert(generation);

    return generation;
  });
}

/**
 * Get a generation by ID, scoped to an account.
 * Returns 404 for cross-account access (not 403, to prevent enumeration).
 */
export async function getGeneration(accountId: string, generationId: string): Promise<Generation> {
  const db = getDb();
  const gen = await db<Generation>('generations')
    .where('id', generationId)
    .where('account_id', accountId)
    .first();

  if (!gen) {
    throw new NotFoundError('Generation');
  }

  return gen;
}

/**
 * List generations for an account with pagination and filtering.
 */
export async function listGenerations(
  accountId: string,
  opts: {
    status?: string;
    limit?: number;
    offset?: number;
    apiKeyId?: string;
  } = {}
): Promise<{ data: Generation[]; total: number; limit: number; offset: number }> {
  const db = getDb();
  const limit = Math.min(opts.limit || 20, 100);
  const offset = opts.offset || 0;

  let query = db<Generation>('generations').where('account_id', accountId);

  if (opts.status) {
    query = query.where('status', opts.status);
  }
  if (opts.apiKeyId) {
    query = query.where('api_key_id', opts.apiKeyId);
  }

  const countResult = await query.clone().count('id as count').first();
  const total = Number((countResult as any)?.count || 0);

  const data = await query
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset);

  return { data, total, limit, offset };
}

/**
 * Cancel a queued or running generation.
 */
export async function cancelGeneration(accountId: string, generationId: string): Promise<Generation> {
  const db = getDb();

  const gen = await db<Generation>('generations')
    .where('id', generationId)
    .where('account_id', accountId)
    .first();

  if (!gen) {
    throw new NotFoundError('Generation');
  }

  if (gen.status !== 'queued' && gen.status !== 'running') {
    throw new BadRequestError(
      'invalid_status',
      `Cannot cancel a generation with status '${gen.status}'. Only queued or running jobs can be canceled.`
    );
  }

  await db('generations')
    .where('id', generationId)
    .update({
      status: 'canceled',
      completed_at: new Date().toISOString(),
    });

  // Refund credits if any were charged
  if (gen.credits_charged > 0) {
    const { refundCredits } = await import('./metering');
    await refundCredits(accountId, generationId, gen.credits_charged, gen.api_key_id);
  }

  return { ...gen, status: 'canceled', completed_at: new Date().toISOString() };
}

