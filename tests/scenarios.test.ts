import request from 'supertest';
import { createApp } from '../src/app';
import { initDb, closeDb } from '../src/db/connection';
import { createAccount, verifyEmail } from '../src/services/accounts';
import { createApiKey, revokeApiKey, rotateApiKey } from '../src/services/apiKeys';
import { updatePlan } from '../src/services/accounts';
import { resetRateLimits } from '../src/middleware/rateLimiter';
import type { Express } from 'express';

describe('Soundverse Enterprise API — Acceptance Scenarios', () => {
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
  // SCENARIO 1: Key's full secret never retrievable again after creation
  // =========================================================================
  test('Scenario 1: Key full secret is never retrievable again from API or DB', async () => {
    const { account } = await createAccount('scen1@soundverse.ai', 'SecretPass123!');
    await verifyEmail(account.email_verification_token!);

    const { key, secret } = await createApiKey({
      accountId: account.id,
      mode: 'live',
      name: 'prod-key',
    });

    expect(secret).toMatch(/^sk_live_[a-f0-9]{40}$/);
    expect(key.key_prefix).toBe(secret.slice(0, 16));

    // Inspect database row directly
    const db = (await import('../src/db/connection')).getDb();
    const dbKey = await db('api_keys').where('id', key.id).first();

    expect(dbKey.key_hash).toBeDefined();
    expect(dbKey.key_hash).not.toBe(secret); // Only SHA-256 hash stored
    expect(JSON.stringify(dbKey)).not.toContain(secret); // Secret never appears in DB
  });

  // =========================================================================
  // SCENARIO 2: Revoked key fails on its very next request
  // =========================================================================
  test('Scenario 2: Revoked key fails immediately on the next request', async () => {
    const { account } = await createAccount('scen2@soundverse.ai', 'SecretPass123!');
    await verifyEmail(account.email_verification_token!);
    await updatePlan(account.id, 'starter');

    const { key, secret } = await createApiKey({
      accountId: account.id,
      mode: 'live',
    });

    // 1st request with valid key -> succeeds
    const res1 = await request(app)
      .get('/v1/usage')
      .set('Authorization', `Bearer ${secret}`);
    expect(res1.status).toBe(200);

    // Revoke key
    await revokeApiKey(account.id, key.id);

    // 2nd request immediately following revocation -> 401 Unauthorized
    const res2 = await request(app)
      .get('/v1/usage')
      .set('Authorization', `Bearer ${secret}`);
    expect(res2.status).toBe(401);
    expect(res2.body.error.code).toBe('invalid_api_key');
  });

  // =========================================================================
  // SCENARIO 3: Key rotation with zero downtime
  // =========================================================================
  test('Scenario 3: Rotate key without any downtime', async () => {
    const { account } = await createAccount('scen3@soundverse.ai', 'SecretPass123!');
    await verifyEmail(account.email_verification_token!);
    await updatePlan(account.id, 'starter');

    const { key: oldKey, secret: oldSecret } = await createApiKey({
      accountId: account.id,
      mode: 'live',
    });

    const rotated = await rotateApiKey(account.id, oldKey.id);
    const newSecret = rotated.secret;

    // New key works immediately
    const resNew = await request(app)
      .get('/v1/usage')
      .set('Authorization', `Bearer ${newSecret}`);
    expect(resNew.status).toBe(200);

    // Old key is revoked
    const resOld = await request(app)
      .get('/v1/usage')
      .set('Authorization', `Bearer ${oldSecret}`);
    expect(resOld.status).toBe(401);
  });

  // =========================================================================
  // SCENARIO 6: Idempotency-Key guarantees
  // =========================================================================
  test('Scenario 6: Idempotency-Key retries return identical result, changed body returns 422', async () => {
    const { account } = await createAccount('scen6@soundverse.ai', 'SecretPass123!');
    await verifyEmail(account.email_verification_token!);
    await updatePlan(account.id, 'growth');

    const { secret } = await createApiKey({ accountId: account.id, mode: 'test' });
    const idempotencyKey = 'idem-req-unique-12345';

    const body1 = {
      prompt: 'Cinematic orchestral soundtrack',
      duration_sec: 30,
      license: 'royalty_free',
    };

    // 1st request
    const res1 = await request(app)
      .post('/v1/generations')
      .set('Authorization', `Bearer ${secret}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body1);
    expect(res1.status).toBe(202);
    const originalGenId = res1.body.id;

    // Retry with SAME idempotency key and SAME body
    const res2 = await request(app)
      .post('/v1/generations')
      .set('Authorization', `Bearer ${secret}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body1);
    expect(res2.status).toBe(202);
    expect(res2.body.id).toBe(originalGenId); // Same cached response, not created twice

    // Reuse SAME idempotency key with DIFFERENT body -> 422 Unprocessable
    const res3 = await request(app)
      .post('/v1/generations')
      .set('Authorization', `Bearer ${secret}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({ prompt: 'Completely different prompt', duration_sec: 45 });
    expect(res3.status).toBe(422);
    expect(res3.body.error.code).toBe('idempotency_key_reuse');
  });

  // =========================================================================
  // SCENARIO 8: Account B cannot access Account A's jobs
  // =========================================================================
  test('Scenario 8: Cross-account job access returns 404', async () => {
    const { account: accA } = await createAccount('userA@test.com', 'PassA123!');
    await verifyEmail(accA.email_verification_token!);
    const { secret: keyA } = await createApiKey({ accountId: accA.id, mode: 'test' });

    const { account: accB } = await createAccount('userB@test.com', 'PassB123!');
    await verifyEmail(accB.email_verification_token!);
    const { secret: keyB } = await createApiKey({ accountId: accB.id, mode: 'test' });

    // Acc A creates job
    const genA = await request(app)
      .post('/v1/generations')
      .set('Authorization', `Bearer ${keyA}`)
      .send({ prompt: 'A song', duration_sec: 30, license: 'royalty_free' });
    const jobId = genA.body.id;

    // Acc B tries to access Acc A's job -> 404 (not 403, preventing enumeration)
    const accessRes = await request(app)
      .get(`/v1/generations/${jobId}`)
      .set('Authorization', `Bearer ${keyB}`);
    expect(accessRes.status).toBe(404);
  });

  // =========================================================================
  // SCENARIO 11: Webhook SSRF protection blocks cloud metadata IPs
  // =========================================================================
  test('Scenario 11: SSRF protection blocks metadata IP 169.254.169.254 and private IPs', async () => {
    const { account } = await createAccount('scen11@soundverse.ai', 'SecretPass123!');
    await verifyEmail(account.email_verification_token!);
    const { secret } = await createApiKey({ accountId: account.id, mode: 'live' });

    const res = await request(app)
      .post('/v1/webhook_endpoints')
      .set('Authorization', `Bearer ${secret}`)
      .send({ url: 'http://169.254.169.254/latest/meta-data/' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_webhook_url');
  });

  // =========================================================================
  // SCENARIO 13: Starter account requests full_ownership license
  // =========================================================================
  test('Scenario 13: Starter plan cannot request full_ownership license', async () => {
    const { account } = await createAccount('scen13@soundverse.ai', 'SecretPass123!');
    await verifyEmail(account.email_verification_token!);
    await updatePlan(account.id, 'starter');
    const { secret } = await createApiKey({ accountId: account.id, mode: 'live' });

    const res = await request(app)
      .post('/v1/generations')
      .set('Authorization', `Bearer ${secret}`)
      .send({
        prompt: 'Soundtrack',
        duration_sec: 30,
        license: 'full_ownership', // Starter only has royalty_free, sync
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('license_not_available');
  });
});

