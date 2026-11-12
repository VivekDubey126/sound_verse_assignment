const { getDb } = require('../db/connection');
const { uuid } = require('../utils/crypto');
const { config } = require('../config');
const { RateLimitError, ForbiddenError } = require('../utils/errors');

function getCurrentPeriod() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  return { start, end };
}

function calculateCredits(license, durationSec) {
  const baseCost = config.creditCosts[license];
  if (baseCost === undefined) {
    throw new ForbiddenError('invalid_license', `Unknown license: ${license}`);
  }
  const units = Math.ceil(durationSec / config.maxDurationPerCredit);
  return baseCost * units;
}

function getUsedCredits(accountId) {
  const db = getDb();
  const period = getCurrentPeriod();
  const res = db.prepare(`
    SELECT COALESCE(SUM(credits), 0) as total FROM usage_ledger 
    WHERE account_id = ? AND period_start = ? AND period_end = ?
  `).get(accountId, period.start, period.end);
  return res ? Number(res.total) : 0;
}

async function checkAndReserveCredits(accountId, apiKeyId, generationId, license, durationSec, plan, isTestKey) {
  if (isTestKey) return 0;

  const credits = calculateCredits(license, durationSec);
  const period = getCurrentPeriod();
  const db = getDb();

  const availableLicenses = JSON.parse(plan.licenses_available || '[]');
  if (!availableLicenses.includes(license)) {
    throw new ForbiddenError('license_not_available', `License '${license}' is not available on ${plan.display_name} plan.`);
  }

  const used = getUsedCredits(accountId);
  const remaining = plan.monthly_allowance - used;

  if (credits > remaining) {
    if (plan.beyond_allowance === 'hard_stop' || plan.beyond_allowance === 'none') {
      throw new RateLimitError('allowance_exceeded', `Monthly allowance exceeded. Used: ${used}/${plan.monthly_allowance} credits.`);
    }
  }

  db.prepare(`
    INSERT INTO usage_ledger (id, account_id, generation_id, credits, license, description, period_start, period_end, api_key_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    accountId,
    generationId,
    credits,
    license,
    `Generation ${generationId} — ${license} (${durationSec}s)`,
    period.start,
    period.end,
    apiKeyId,
    new Date().toISOString()
  );

  return credits;
}

async function refundCredits(accountId, generationId, credits, apiKeyId) {
  if (credits <= 0) return;
  const db = getDb();
  const period = getCurrentPeriod();

  db.prepare(`
    INSERT INTO usage_ledger (id, account_id, generation_id, credits, license, description, period_start, period_end, api_key_id, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    accountId,
    generationId,
    -credits,
    `Refund for failed generation ${generationId}`,
    period.start,
    period.end,
    apiKeyId,
    new Date().toISOString()
  );
}

async function getUsageSummary(accountId, plan) {
  const db = getDb();
  const period = getCurrentPeriod();
  const used = getUsedCredits(accountId);

  // 1. Usage per key
  const byKeyRaw = db.prepare(`
    SELECT u.api_key_id, COALESCE(k.key_prefix, 'Dashboard / Internal') as prefix, COALESCE(k.mode, 'live') as mode, SUM(u.credits) as credits
    FROM usage_ledger u
    LEFT JOIN api_keys k ON u.api_key_id = k.id
    WHERE u.account_id = ? AND u.period_start = ? AND u.period_end = ?
    GROUP BY u.api_key_id
  `).all(accountId, period.start, period.end);

  // 2. Usage per day (in current month)
  const byDayRaw = db.prepare(`
    SELECT substr(created_at, 1, 10) as date, SUM(credits) as credits
    FROM usage_ledger
    WHERE account_id = ? AND period_start = ? AND period_end = ?
    GROUP BY substr(created_at, 1, 10)
    ORDER BY date ASC
  `).all(accountId, period.start, period.end);

  return {
    plan: plan.name,
    period,
    allowance: {
      total: plan.monthly_allowance,
      used,
      remaining: Math.max(0, plan.monthly_allowance - used),
    },
    beyond_allowance: plan.beyond_allowance,
    by_key: byKeyRaw.map(r => ({ ...r, credits: Number(r.credits) })),
    by_day: byDayRaw.map(r => ({ ...r, credits: Number(r.credits) })),
  };
}

module.exports = {
  getCurrentPeriod,
  calculateCredits,
  getUsedCredits,
  checkAndReserveCredits,
  refundCredits,
  getUsageSummary,
};

