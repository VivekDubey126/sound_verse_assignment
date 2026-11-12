import { getDb } from '../db/connection';
import { uuid } from '../utils/ids';
import { config } from '../config';
import { RateLimitError, ForbiddenError } from '../utils/errors';
import type { Plan, UsageLedgerEntry } from '../types';

/**
 * Get the current billing period for an account.
 * Period is monthly, starting from the 1st of the month.
 */
export function getCurrentPeriod(accountPeriodStart?: string): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

/**
 * Calculate credits required for a generation.
 * One generation covers up to 60 seconds; longer costs the same again per started 60s.
 */
export function calculateCredits(license: string, durationSec: number): number {
  const baseCost = config.creditCosts[license];
  if (baseCost === undefined) {
    throw new ForbiddenError('invalid_license', `Unknown license type: ${license}`);
  }
  const units = Math.ceil(durationSec / config.maxDurationPerCredit);
  return baseCost * units;
}

/**
 * Get total credits used in the current period for an account.
 */
export async function getUsedCredits(accountId: string): Promise<number> {
  const db = getDb();
  const period = getCurrentPeriod();

  const result = await db('usage_ledger')
    .where('account_id', accountId)
    .where('period_start', period.start)
    .where('period_end', period.end)
    .sum('credits as total')
    .first();

  return (result as any)?.total || 0;
}

/**
 * Get usage broken down by API key for the current period.
 */
export async function getUsageByKey(accountId: string): Promise<Array<{ api_key_id: string; credits: number }>> {
  const db = getDb();
  const period = getCurrentPeriod();

  return db('usage_ledger')
    .where('account_id', accountId)
    .where('period_start', period.start)
    .where('period_end', period.end)
    .groupBy('api_key_id')
    .select('api_key_id')
    .sum('credits as credits');
}

/**
 * Get daily usage for the current period.
 */
export async function getDailyUsage(accountId: string): Promise<Array<{ date: string; credits: number }>> {
  const db = getDb();
  const period = getCurrentPeriod();

  // SQLite date function
  return db('usage_ledger')
    .where('account_id', accountId)
    .where('period_start', period.start)
    .where('period_end', period.end)
    .select(db.raw("substr(created_at, 1, 10) as date"))
    .sum('credits as credits')
    .groupByRaw("substr(created_at, 1, 10)")
    .orderBy('date');
}

/**
 * Check if the account has enough allowance for a generation.
 * This is called INSIDE the account lock for concurrency safety.
 *
 * For test keys: always passes (no credits consumed).
 * For live keys: checks plan allowance.
 */
export async function checkAndReserveCredits(
  accountId: string,
  apiKeyId: string,
  generationId: string,
  license: string,
  durationSec: number,
  plan: Plan,
  isTestKey: boolean
): Promise<number> {
  if (isTestKey) {
    return 0; // Test keys don't consume allowance
  }

  const credits = calculateCredits(license, durationSec);
  const period = getCurrentPeriod();
  const db = getDb();

  // Check license availability
  const availableLicenses: string[] = JSON.parse(plan.licenses_available);
  if (!availableLicenses.includes(license)) {
    throw new ForbiddenError(
      'license_not_available',
      `License '${license}' is not available on the ${plan.display_name} plan. Available: ${availableLicenses.join(', ')}`
    );
  }

  // Sandbox plan cannot use live keys for generations
  if (plan.monthly_allowance === 0 && plan.beyond_allowance === 'none') {
    throw new ForbiddenError(
      'sandbox_live_key_not_allowed',
      'Sandbox plan does not support live key generations. Use a test key or upgrade your plan.'
    );
  }

  // Check current usage
  const usedCredits = await getUsedCredits(accountId);
  const remaining = plan.monthly_allowance - usedCredits;

  if (credits > remaining) {
    if (plan.beyond_allowance === 'hard_stop') {
      throw new RateLimitError(
        'allowance_exceeded',
        `Monthly allowance exceeded. Used: ${usedCredits}/${plan.monthly_allowance} credits. This generation requires ${credits} credits.`
      );
    } else if (plan.beyond_allowance === 'overage') {
      // Allow but it's overage — will be billed separately
      // Continue to record the usage
    } else {
      throw new RateLimitError(
        'allowance_exceeded',
        `Monthly allowance exceeded.`
      );
    }
  }

  // Record usage in the ledger (append-only)
  const ledgerEntry: Partial<UsageLedgerEntry> = {
    id: uuid(),
    account_id: accountId,
    generation_id: generationId,
    credits,
    license,
    description: `Generation ${generationId} — ${license} — ${durationSec}s`,
    period_start: period.start,
    period_end: period.end,
    api_key_id: apiKeyId,
    created_at: new Date().toISOString(),
  };

  await db('usage_ledger').insert(ledgerEntry);

  return credits;
}

/**
 * Refund credits for a failed generation.
 * Recorded as a negative entry in the ledger.
 */
export async function refundCredits(
  accountId: string,
  generationId: string,
  credits: number,
  apiKeyId: string
): Promise<void> {
  if (credits <= 0) return;

  const db = getDb();
  const period = getCurrentPeriod();

  const ledgerEntry: Partial<UsageLedgerEntry> = {
    id: uuid(),
    account_id: accountId,
    generation_id: generationId,
    credits: -credits, // Negative = refund
    license: null,
    description: `Refund for failed generation ${generationId}`,
    period_start: period.start,
    period_end: period.end,
    api_key_id: apiKeyId,
    created_at: new Date().toISOString(),
  };

  await db('usage_ledger').insert(ledgerEntry);
}

/**
 * Get full usage summary for an account.
 */
export async function getUsageSummary(accountId: string, plan: Plan) {
  const period = getCurrentPeriod();
  const usedCredits = await getUsedCredits(accountId);
  const byKey = await getUsageByKey(accountId);
  const daily = await getDailyUsage(accountId);

  return {
    plan: plan.name,
    period: {
      start: period.start,
      end: period.end,
    },
    allowance: {
      total: plan.monthly_allowance,
      used: usedCredits,
      remaining: Math.max(0, plan.monthly_allowance - usedCredits),
    },
    beyond_allowance: plan.beyond_allowance,
    by_key: byKey,
    daily,
  };
}

