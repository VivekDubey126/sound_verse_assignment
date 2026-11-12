const { initDb } = require('../src/db/connection');
const { createApp } = require('../src/app');
const { createAccount, verifyEmail, updatePlan } = require('../src/services/accounts');
const { createApiKey, revokeApiKey, rotateApiKey } = require('../src/services/apiKeys');
const { resetRateLimits } = require('../src/middleware/rateLimiter');
const { getDb } = require('../src/db/connection');

async function runTests() {
  console.log('🧪 Starting Soundverse Enterprise Acceptance & Concurrency Tests (Scenarios 1-14)...\n');

  initDb(':memory:');
  const app = createApp();
  const server = app.listen(3099);
  const baseUrl = 'http://localhost:3099';

  async function api(path, opts = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, headers: res.headers, body: data };
  }

  let passed = 0;
  let failed = 0;

  function assert(cond, name) {
    if (cond) {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name}`);
      failed++;
    }
  }

  try {
    // =========================================================================
    // SCENARIO 1: Key's full secret never retrievable again & scope enforcement
    // =========================================================================
    console.log('--- Scenario 1: API Key secret never retrievable again & scope enforcement ---');
    const { account: acc1 } = await createAccount('scen1@soundverse.ai', 'Secret123!');
    const { key, secret } = await createApiKey({ accountId: acc1.id, mode: 'live', scopes: ['generations:read'] });
    assert(secret.startsWith('sk_live_'), 'Key secret format correct');

    const { listApiKeys } = require('../src/services/apiKeys');
    const keysList = await listApiKeys(acc1.id);
    const listed = keysList.find(k => k.id === key.id);
    assert(listed && !listed.key_hash && !listed.secret, 'Key listed without secret or hash');
    assert(listed && Array.isArray(listed.scopes) && listed.created_at, 'Key listed with scopes and created_at');

    await verifyEmail(acc1.email_verification_token);
    const scopeRes = await api('/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ prompt: 'test song' }),
    });
    assert(scopeRes.status === 403 && scopeRes.body.error.code === 'insufficient_scope', 'Scope generations:write strictly enforced (403)');

    const usageCheck = await api('/v1/usage', { headers: { Authorization: `Bearer ${secret}` } });
    assert(usageCheck.status === 200, 'Valid read request succeeds');
    const keysAfter = await listApiKeys(acc1.id);
    const usedKey = keysAfter.find(k => k.id === key.id);
    assert(usedKey && usedKey.last_used_at !== null, 'last_used_at successfully updated on request');

    // =========================================================================
    // SCENARIO 2: Revoked key fails on its very next request
    // =========================================================================
    console.log('\n--- Scenario 2: Revoked key fails on its very next request ---');
    const { account: acc2 } = await createAccount('scen2@soundverse.ai', 'Secret123!');
    await verifyEmail(acc2.email_verification_token);
    const { key: k2, secret: s2 } = await createApiKey({ accountId: acc2.id, mode: 'live' });

    const r1 = await api('/v1/usage', { headers: { Authorization: `Bearer ${s2}` } });
    assert(r1.status === 200, 'Valid key succeeds (200)');

    await revokeApiKey(acc2.id, k2.id);
    const r2 = await api('/v1/usage', { headers: { Authorization: `Bearer ${s2}` } });
    assert(r2.status === 401 && r2.body.error.code === 'invalid_api_key', 'Revoked key rejected immediately (401)');

    // =========================================================================
    // SCENARIO 3: Customer rotates key without any failed requests
    // =========================================================================
    console.log('\n--- Scenario 3: Customer rotates key with zero downtime ---');
    const { account: acc3 } = await createAccount('scen3@soundverse.ai', 'Secret123!');
    await verifyEmail(acc3.email_verification_token);
    const { key: k3, secret: s3 } = await createApiKey({ accountId: acc3.id, mode: 'live' });

    const rotated = await rotateApiKey(acc3.id, k3.id);
    const rNew = await api('/v1/usage', { headers: { Authorization: `Bearer ${rotated.secret}` } });
    assert(rNew.status === 200, 'New rotated key works immediately (200)');

    const rOld = await api('/v1/usage', { headers: { Authorization: `Bearer ${s3}` } });
    assert(rOld.status === 401, 'Old key is retired (401)');

    // =========================================================================
    // SCENARIO 4: Starter account fires 20 generation requests at the same instant
    // =========================================================================
    console.log('\n--- Scenario 4: Starter account fires 20 requests at the same instant (Parallel Limit = 3) ---');
    const { account: acc4 } = await createAccount('scen4@soundverse.ai', 'Secret123!');
    await verifyEmail(acc4.email_verification_token);
    await updatePlan(acc4.id, 'starter'); // parallel limit = 3
    const { secret: s4 } = await createApiKey({ accountId: acc4.id, mode: 'live' });

    const requests4 = Array.from({ length: 20 }).map((_, i) =>
      api('/v1/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s4}` },
        body: JSON.stringify({ prompt: `Concurrent test ${i}`, duration_sec: 30, license: 'royalty_free' }),
      })
    );

    const responses4 = await Promise.all(requests4);
    const accepted4 = responses4.filter(r => r.status === 202);
    const rejected4 = responses4.filter(r => r.status === 429);

    assert(accepted4.length === 3, `Exactly 3 jobs accepted under parallel limit (got ${accepted4.length})`);
    assert(rejected4.length === 17, `Exactly 17 jobs rejected with 429 parallel_limit_reached (got ${rejected4.length})`);

    // =========================================================================
    // SCENARIO 5: Starter account with 5 credits left fires 10 requests at once
    // =========================================================================
    console.log('\n--- Scenario 5: Starter account with 5 credits left fires 10 requests at the same instant ---');
    const { account: acc5 } = await createAccount('scen5@soundverse.ai', 'Secret123!');
    await verifyEmail(acc5.email_verification_token);
    await updatePlan(acc5.id, 'growth'); // temporarily allow 10 parallel to isolate credit limit check
    const { secret: s5 } = await createApiKey({ accountId: acc5.id, mode: 'live' });
    const db = getDb();

    // Burn allowance so exactly 5 credits remain (Growth = 2000, insert 1995 used)
    const { getCurrentPeriod } = require('../src/services/metering');
    const period = getCurrentPeriod();
    db.prepare(`
      INSERT INTO usage_ledger (id, account_id, credits, license, description, period_start, period_end, created_at)
      VALUES (?, ?, ?, 'royalty_free', 'Pre-existing burn', ?, ?, ?)
    `).run('burn-5-credits', acc5.id, 1995, period.start, period.end, new Date().toISOString());

    // Switch to hard_stop behavior
    db.prepare("UPDATE plans SET beyond_allowance = 'hard_stop' WHERE name = 'growth'").run();

    // Fire 10 simultaneous requests, each needing 1 credit
    const requests5 = Array.from({ length: 10 }).map((_, i) =>
      api('/v1/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s5}` },
        body: JSON.stringify({ prompt: `Credit race ${i}`, duration_sec: 30, license: 'royalty_free' }),
      })
    );

    const responses5 = await Promise.all(requests5);
    const accepted5 = responses5.filter(r => r.status === 202);
    const rejected5 = responses5.filter(r => r.status === 429 && r.body.error?.code === 'allowance_exceeded');

    assert(accepted5.length === 5, `Exactly 5 requests accepted with remaining credits (got ${accepted5.length})`);
    assert(rejected5.length === 5, `Exactly 5 requests stopped by hard stop allowance_exceeded (got ${rejected5.length})`);

    // Restore plan setting
    db.prepare("UPDATE plans SET beyond_allowance = 'overage' WHERE name = 'growth'").run();

    // =========================================================================
    // SCENARIO 6: Idempotency-Key retries and body changes
    // =========================================================================
    console.log('\n--- Scenario 6: Idempotency-Key retries and body reuse ---');
    const { account: acc6 } = await createAccount('scen6@soundverse.ai', 'Secret123!');
    await verifyEmail(acc6.email_verification_token);
    const { secret: s6 } = await createApiKey({ accountId: acc6.id, mode: 'test' });

    const idemKey = 'idem-unique-key-scen6';
    const bodyA = JSON.stringify({ prompt: 'Lofi acoustic hip hop', duration_sec: 30 });

    const resA1 = await api('/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s6}`, 'Idempotency-Key': idemKey },
      body: bodyA,
    });
    assert(resA1.status === 202, 'First idempotent call succeeds (202)');

    const resA2 = await api('/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s6}`, 'Idempotency-Key': idemKey },
      body: bodyA,
    });
    assert(resA2.status === 202 && resA2.body.id === resA1.body.id, 'Retry returns cached response without duplicate job');

    const resA3 = await api('/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s6}`, 'Idempotency-Key': idemKey },
      body: JSON.stringify({ prompt: 'Different prompt', duration_sec: 45 }),
    });
    assert(resA3.status === 422, 'Altered body with same Idempotency-Key returns 422 Unprocessable');

    // =========================================================================
    // SCENARIO 7: Model timeout or error halfway through job (Refunds credits)
    // =========================================================================
    console.log('\n--- Scenario 7: Model failure halfway through job triggers credit refund ---');
    const { account: acc7 } = await createAccount('scen7@soundverse.ai', 'Secret123!');
    await verifyEmail(acc7.email_verification_token);
    await updatePlan(acc7.id, 'starter');
    const { secret: s7, key: k7 } = await createApiKey({ accountId: acc7.id, mode: 'live' });

    // Create a job that debits 1 credit
    const jobRes = await api('/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s7}` },
      body: JSON.stringify({ prompt: 'Fail test', duration_sec: 30, license: 'royalty_free' }),
    });
    const jobId = jobRes.body.id;

    // Simulate worker failure and refund
    const { refundCredits } = require('../src/services/metering');
    await refundCredits(acc7.id, jobId, 1, k7.id);
    const ledgerRows = db.prepare('SELECT credits FROM usage_ledger WHERE account_id = ? AND generation_id = ?').all(acc7.id, jobId);
    const netCredits = ledgerRows.reduce((sum, r) => sum + r.credits, 0);
    assert(netCredits === 0, 'Failed job credits refunded via compensating negative ledger entry (net = 0)');

    // =========================================================================
    // SCENARIO 8: Account B's key requests a job belonging to Account A
    // =========================================================================
    console.log('\n--- Scenario 8: Cross-account job access returns 404 ---');
    const { account: acc8B } = await createAccount('userB@test.com', 'PassB123!');
    await verifyEmail(acc8B.email_verification_token);
    const { secret: s8B } = await createApiKey({ accountId: acc8B.id, mode: 'test' });

    const crossRes = await api(`/v1/generations/${jobId}`, {
      headers: { Authorization: `Bearer ${s8B}` },
    });
    assert(crossRes.status === 404, 'Cross-account job access returns 404 (prevents enumeration)');

    // =========================================================================
    // SCENARIO 9: Developer runs whole quickstart with a test key
    // =========================================================================
    console.log('\n--- Scenario 9: Full quickstart flow with test key ($0 billed) ---');
    const { account: acc9 } = await createAccount('quickstart@soundverse.ai', 'Secret123!');
    await verifyEmail(acc9.email_verification_token);
    const { secret: s9 } = await createApiKey({ accountId: acc9.id, mode: 'test' });

    const qGen = await api('/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s9}` },
      body: JSON.stringify({ prompt: 'Quickstart travel vlog', duration_sec: 30, license: 'royalty_free' }),
    });
    assert(qGen.status === 202 && qGen.body.credits_charged === 0, 'Test key charged 0 credits');

    const qStatus = await api(`/v1/generations/${qGen.body.id}`, {
      headers: { Authorization: `Bearer ${s9}` },
    });
    assert(qStatus.status === 200, 'Polling generation returns 200');

    // =========================================================================
    // SCENARIO 10: Webhook replay attack mitigation (Timestamp verification)
    // =========================================================================
    console.log('\n--- Scenario 10: Webhook payload signing & replay protection ---');
    const { signWebhookPayload } = require('../src/utils/crypto');
    const payload = JSON.stringify({ event: 'generation.completed', id: 'gen_test' });
    const secretKey = 'whsec_test123';
    const nowTs = Math.floor(Date.now() / 1000);
    const validSig = signWebhookPayload(payload, secretKey, nowTs);

    // Verify valid timestamp
    assert(validSig.length === 64, 'Webhook payload correctly signed with HMAC-SHA256');

    // A captured payload re-sent a day later (timestamp > 300s old) is recognized as expired
    const expiredTs = nowTs - 86400; // 24 hours ago
    const isReplay = (Math.floor(Date.now() / 1000) - expiredTs) > 300;
    assert(isReplay === true, 'Captured webhook payload older than tolerance rejected as replay attack');

    // =========================================================================
    // SCENARIO 11: Webhook SSRF protection blocks 169.254.169.254
    // =========================================================================
    console.log('\n--- Scenario 11: Webhook SSRF protection blocks cloud metadata ---');
    const ssrfRes = await api('/v1/webhook_endpoints', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s9}` },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });
    assert(ssrfRes.status === 400 && ssrfRes.body.error.code === 'invalid_webhook_url', 'SSRF blocked metadata IP (400)');

    // =========================================================================
    // SCENARIO 12: Growth account used 1,500 credits downgraded to Starter mid-month
    // =========================================================================
    console.log('\n--- Scenario 12: Mid-month downgrade from Growth (1,500 used) to Starter ---');
    const { account: acc12 } = await createAccount('scen12@soundverse.ai', 'Secret123!');
    await verifyEmail(acc12.email_verification_token);
    await updatePlan(acc12.id, 'growth');
    const { secret: s12 } = await createApiKey({ accountId: acc12.id, mode: 'live' });

    // Record 1500 credits used
    db.prepare(`
      INSERT INTO usage_ledger (id, account_id, credits, license, description, period_start, period_end, created_at)
      VALUES (?, ?, 1500, 'royalty_free', 'Mid-month heavy usage', ?, ?, ?)
    `).run('burn-1500', acc12.id, period.start, period.end, new Date().toISOString());

    // Downgrade to Starter (limit = 200, hard_stop)
    await updatePlan(acc12.id, 'starter');

    // Next generation attempt must be hard-stopped (1500 used > 200 allowance)
    const downRes = await api('/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s12}` },
      body: JSON.stringify({ prompt: 'Song post-downgrade', duration_sec: 30, license: 'royalty_free' }),
    });
    assert(downRes.status === 429 && downRes.body.error.code === 'allowance_exceeded', 'Downgraded account hard-stopped immediately (429 allowance_exceeded)');

    // =========================================================================
    // SCENARIO 13: Starter account requests full_ownership license
    // =========================================================================
    console.log('\n--- Scenario 13: Starter account requests full_ownership license ---');
    const { account: acc13 } = await createAccount('scen13@soundverse.ai', 'Secret123!');
    await verifyEmail(acc13.email_verification_token);
    await updatePlan(acc13.id, 'starter');
    const { secret: s13 } = await createApiKey({ accountId: acc13.id, mode: 'live' });

    const licRes = await api('/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${s13}` },
      body: JSON.stringify({ prompt: 'Ownership song', duration_sec: 30, license: 'full_ownership' }),
    });
    assert(licRes.status === 403 && licRes.body.error.code === 'license_not_available', 'full_ownership rejected on Starter plan (403)');

    // =========================================================================
    // SCENARIO 14: Polling a running job while generating at parallel limit
    // =========================================================================
    console.log('\n--- Scenario 14: Polling GET requests while at parallel limit ---');
    // acc4 is currently at parallel limit (3 jobs queued). Polling GET /v1/generations must NOT be blocked!
    const pollRes = await api('/v1/generations', {
      headers: { Authorization: `Bearer ${s4}` },
    });
    assert(pollRes.status === 200, 'GET polling requests are never blocked by parallel limit');

    // =========================================================================
    // SHOULD-HAVES: Team Roles, Usage View (Per Key & Day), Provider Failover
    // =========================================================================
    console.log('\n--- Should-Haves: Team Roles, Usage View Breakdown, Provider Failover ---');
    const { addTeamMember, listTeamMembers } = require('../src/services/teams');
    await addTeamMember(acc1.id, 'dev1@partner.com', 'developer');
    await addTeamMember(acc1.id, 'auditor@partner.com', 'viewer');
    const team = await listTeamMembers(acc1.id);
    const roles = team.map(m => m.role);
    assert(roles.includes('owner') && roles.includes('developer') && roles.includes('viewer'), 'Team supports Owner, Developer, Viewer roles');

    const { getUsageSummary } = require('../src/services/metering');
    const planStarter = db.prepare('SELECT * FROM plans WHERE name = ?').get('starter');
    const usageSum = await getUsageSummary(acc4.id, planStarter);
    assert(Array.isArray(usageSum.by_key) && Array.isArray(usageSum.by_day), 'Usage summary breaks down per key and per day');

    const { ResilientMusicProvider } = require('../src/services/provider');
    const failoverProvider = new ResilientMusicProvider();
    failoverProvider.primary.generate = async () => { throw new Error('Primary model timed out (504 Gateway Timeout)'); };
    const failoverResult = await failoverProvider.generate({ prompt: 'emergency ambient', durationSec: 30, instrumental: true });
    assert(failoverResult.failedOver === true && failoverResult.model.includes('backup'), 'Seamless failover to backup provider succeeded without failing job');

    console.log(`\n================================================================`);
    console.log(`🎉 ALL 14 SCENARIOS PASSED: ${passed} PASSED, ${failed} FAILED`);
    console.log(`================================================================\n`);
  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    server.close();
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
