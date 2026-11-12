import request from 'supertest';
import { createApp } from '../src/app';
import { initDb, closeDb } from '../src/db/connection';
import { createAccount, verifyEmail, updatePlan } from '../src/services/accounts';
import { createApiKey } from '../src/services/apiKeys';
import { resetRateLimits } from '../src/middleware/rateLimiter';
import type { Express } from 'express';

describe('Soundverse Enterprise API — Concurrency & Limit Enforcement', () => {
  let app: Express;
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const db = await initDb();
    await db.migrate.latest();
    await db.seed.run();
    app = createApp();
  });
  afterAll(async () => {
    await closeDb();
  });

  beforeEach(() => {
    resetRateLimits();
  });

  // =========================================================================
  // SCENARIO 4: Starter account fires 20 generation requests at the same instant
  // =========================================================================
  test('Scenario 4: Starter account (parallel limit = 3) fires 20 requests at the same instant', async () => {
    const { account } = await createAccount('concurrent_starter@soundverse.ai', 'Pass123!');
    await verifyEmail(account.email_verification_token!);
    await updatePlan(account.id, 'starter'); // parallel limit = 3

    const { secret } = await createApiKey({ accountId: account.id, mode: 'live' });

    // Fire 20 requests simultaneously using Promise.all
    const promises = Array.from({ length: 20 }).map((_, i) =>
      request(app)
        .post('/v1/generations')
        .set('Authorization', `Bearer ${secret}`)
        .send({
          prompt: `Concurrent generation test #${i}`,
          duration_sec: 30,
          license: 'royalty_free',
        })
    );

    const responses = await Promise.all(promises);

    const accepted = responses.filter((r) => r.status === 202);
    const rejected = responses.filter((r) => r.status === 429);

    // Exactly 3 jobs accepted (parallel limit), remaining 17 rejected with 429 parallel_limit_reached
    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(17);

    rejected.forEach((r) => {
      expect(r.body.error.code).toBe('parallel_limit_reached');
    });
  });

  // =========================================================================
  // SCENARIO 5: Starter account with 5 credits left fires 10 requests at once
  // =========================================================================
  test('Scenario 5: Account with 5 credits left fires 10 requests at once', async () => {
    const { account } = await createAccount('credits_race@soundverse.ai', 'Pass123!');
    await verifyEmail(account.email_verification_token!);
    await updatePlan(account.id, 'growth'); // Growth allows up to 10 parallel

    const { secret } = await createApiKey({ accountId: account.id, mode: 'live' });
    const db = (await import('../src/db/connection')).getDb();

    // Artificially consume allowance so only 5 credits remain (Growth = 2000 allowance, insert 1995 used)
    const { getCurrentPeriod } = await import('../src/services/metering');
    const period = getCurrentPeriod();
    await db('usage_ledger').insert({
      id: 'pre-existing-usage-burn',
      account_id: account.id,
      credits: 1995,
      license: 'royalty_free',
      description: 'Burn 1995 credits to leave exactly 5 remaining',
      period_start: period.start,
      period_end: period.end,
      created_at: new Date().toISOString(),
    });

    // Temporarily switch to starter rules (hard stop)
    await db('plans').where('name', 'growth').update({ beyond_allowance: 'hard_stop' });

    // Fire 10 simultaneous requests, each needing 1 credit (royalty_free, 30s)
    const promises = Array.from({ length: 10 }).map((_, i) =>
      request(app)
        .post('/v1/generations')
        .set('Authorization', `Bearer ${secret}`)
        .send({
          prompt: `Credit race generation #${i}`,
          duration_sec: 30,
          license: 'royalty_free',
        })
    );

    const responses = await Promise.all(promises);

    const accepted = responses.filter((r) => r.status === 202);
    const rejected = responses.filter((r) => r.status === 429);

    // Exactly 5 requests can succeed, all others must be stopped by the hard stop
    expect(accepted.length).toBe(5);
    expect(rejected.length).toBe(5);

    rejected.forEach((r) => {
      expect(r.body.error.code).toBe('allowance_exceeded');
    });

    // Restore plan setting
    await db('plans').where('name', 'growth').update({ beyond_allowance: 'overage' });
  });
});

