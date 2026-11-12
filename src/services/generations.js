const { getDb } = require('../db/connection');
const { generateId, generateSignedUrl } = require('../utils/crypto');
const { accountLock } = require('../utils/lock');
const { checkAndReserveCredits, refundCredits } = require('./metering');
const { NotFoundError, RateLimitError, ForbiddenError, BadRequestError } = require('../utils/errors');

function formatGeneration(g) {
  return {
    id: g.id,
    status: g.status,
    license: g.license,
    credits_charged: g.credits_charged,
    prompt: g.prompt,
    duration_sec: g.duration_sec,
    instrumental: Boolean(g.instrumental),
    metadata: JSON.parse(g.metadata || '{}'),
    output: g.status === 'succeeded' && g.output_url ? {
      audio_url: generateSignedUrl(g.id),
      duration_sec: g.output_duration_sec,
      format: g.output_format || 'mp3',
    } : null,
    model: g.model,
    created_at: g.created_at,
    started_at: g.started_at,
    completed_at: g.completed_at,
  };
}

async function createGeneration(opts) {
  const db = getDb();

  return accountLock.acquire(opts.accountId, async () => {
    // Check parallel limit
    const activeRes = db.prepare(`
      SELECT COUNT(*) as count FROM generations 
      WHERE account_id = ? AND status IN ('queued', 'running')
    `).get(opts.accountId);

    const activeCount = Number(activeRes ? activeRes.count : 0);
    if (activeCount >= opts.plan.parallel_generations) {
      throw new RateLimitError(
        'parallel_limit_reached',
        `Parallel limit reached: ${activeCount}/${opts.plan.parallel_generations} active jobs.`
      );
    }

    const genId = generateId('gen');

    const credits = await checkAndReserveCredits(
      opts.accountId,
      opts.apiKeyId,
      genId,
      opts.license,
      opts.durationSec,
      opts.plan,
      opts.isTestKey
    );

    const model = opts.isTestKey ? 'mock/test-v1' : 'soundverse/music-v1';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO generations (id, account_id, api_key_id, prompt, duration_sec, license, instrumental, metadata, status, model, credits_charged, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(
      genId,
      opts.accountId,
      opts.apiKeyId,
      opts.prompt,
      opts.durationSec,
      opts.license,
      opts.instrumental ? 1 : 0,
      JSON.stringify(opts.metadata || {}),
      model,
      credits,
      opts.idempotencyKey || null,
      now
    );

    return db.prepare('SELECT * FROM generations WHERE id = ?').get(genId);
  });
}

async function getGeneration(accountId, generationId) {
  const db = getDb();
  const gen = db.prepare('SELECT * FROM generations WHERE id = ? AND account_id = ?').get(generationId, accountId);
  if (!gen) throw new NotFoundError('Generation');
  return gen;
}

async function listGenerations(accountId, opts = {}) {
  const db = getDb();
  const limit = Math.min(opts.limit || 20, 100);
  const offset = opts.offset || 0;

  let sql = 'SELECT * FROM generations WHERE account_id = ?';
  const params = [accountId];

  if (opts.status) {
    sql += ' AND status = ?';
    params.push(opts.status);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const data = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as count FROM generations WHERE account_id = ?').get(accountId).count;

  return { data, total, limit, offset };
}

async function cancelGeneration(accountId, generationId) {
  const db = getDb();
  const gen = db.prepare('SELECT * FROM generations WHERE id = ? AND account_id = ?').get(generationId, accountId);
  if (!gen) throw new NotFoundError('Generation');

  if (gen.status !== 'queued' && gen.status !== 'running') {
    throw new BadRequestError('invalid_status', `Cannot cancel generation with status '${gen.status}'`);
  }

  db.prepare("UPDATE generations SET status = 'canceled', completed_at = ? WHERE id = ?").run(new Date().toISOString(), generationId);

  if (gen.credits_charged > 0) {
    await refundCredits(accountId, generationId, gen.credits_charged, gen.api_key_id);
  }

  return db.prepare('SELECT * FROM generations WHERE id = ?').get(generationId);
}

module.exports = {
  createGeneration,
  getGeneration,
  listGenerations,
  cancelGeneration,
  formatGeneration,
};

