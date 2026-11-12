/**
 * Test Suite for Team Memberships, Multi-Tenant Workspaces, and RBAC
 */
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
    throw new Error(message);
  } else {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`http://127.0.0.1:3000${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.statusCode || res.status, body };
}

async function run() {
  console.log('🧪 Starting Team Membership & RBAC Test Suite against live server...\n');

  try {
    const timestamp = Date.now();
    const ownerEmail = `noob4coder_${timestamp}@gmail.com`;
    const dubeEmail = `dubeprince024_${timestamp}@gmail.com`;

    // -------------------------------------------------------------------------
    // Test 1: Owner invites X; X signs up fresh -> X sees owner account, role VIEWER, no personal account
    // -------------------------------------------------------------------------
    console.log('--- Test 1: Owner invites X; X signs up fresh -> X sees owner account, role VIEWER, no personal account ---');
    const ownerSignup = await api('/auth/signup', {
      method: 'POST',
      body: { email: ownerEmail, password: 'Pass1234!', name: 'Owner' },
    });
    const verifyToken = ownerSignup.body.verification_link?.split('token=')[1];
    if (verifyToken) await api(`/auth/verify?token=${verifyToken}`);

    const ownerLogin = await api('/auth/login', {
      method: 'POST',
      body: { email: ownerEmail, password: 'Pass1234!' },
    });
    const ownerToken = ownerLogin.body.token;
    const accountAId = ownerLogin.body.account.id;
    assert(!!ownerToken && !!accountAId, 'Owner logged in successfully');

    // Owner invites DubePrince024 (case-insensitive) as VIEWER
    const inviteRes = await api('/dashboard/team', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { email: dubeEmail.toUpperCase(), role: 'viewer' },
    });
    assert(inviteRes.status === 201, 'Owner successfully invited member as VIEWER (201)');

    // Dube signs in fresh via Google
    const dubeLogin = await api('/auth/google', {
      method: 'POST',
      body: { email: dubeEmail, name: 'Vivek Dubey' },
    });
    assert(dubeLogin.status === 200, 'Dube signed in via Google (200)');
    assert(dubeLogin.body.account.id === accountAId, 'Invited user Dube lands directly in Owner Account A!');
    assert(dubeLogin.body.role === 'viewer', 'Dube role is VIEWER');
    assert(dubeLogin.body.memberships.length === 1, 'Dube has exactly 1 membership (no redundant personal account)');

    // -------------------------------------------------------------------------
    // Test 2: VIEWER calling POST/DELETE on keys, plan, members directly -> 403
    // -------------------------------------------------------------------------
    console.log('\n--- Test 2: VIEWER cannot create keys, change plan, or invite members (403) ---');
    const dubeToken = dubeLogin.body.token;

    // Try creating key as viewer
    const createKeyRes = await api('/dashboard/keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${dubeToken}` },
      body: { name: 'Malicious Key', mode: 'live' },
    });
    assert(createKeyRes.status === 403, 'VIEWER blocked from creating API key (403)');

    // Try updating plan as viewer
    const planRes = await api('/dashboard/plan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${dubeToken}` },
      body: { plan: 'growth' },
    });
    assert(planRes.status === 403, 'VIEWER blocked from updating plan (403)');

    // Try inviting members as viewer
    const addMemRes = await api('/dashboard/team', {
      method: 'POST',
      headers: { Authorization: `Bearer ${dubeToken}` },
      body: { email: 'someone@gmail.com', role: 'viewer' },
    });
    assert(addMemRes.status === 403, 'VIEWER blocked from managing team members (403)');

    // -------------------------------------------------------------------------
    // Test 3: Existing user with their own account is invited -> belongs to both
    // -------------------------------------------------------------------------
    console.log('\n--- Test 3: Existing user with own account is invited -> belongs to both ---');
    const userBEmail = `independent_dev_${timestamp}@gmail.com`;
    const userBSignup = await api('/auth/signup', {
      method: 'POST',
      body: { email: userBEmail, password: 'Pass1234!', name: 'User B' },
    });
    const userBVerify = userBSignup.body.verification_link?.split('token=')[1];
    if (userBVerify) await api(`/auth/verify?token=${userBVerify}`);

    const userBLogin = await api('/auth/login', {
      method: 'POST',
      body: { email: userBEmail, password: 'Pass1234!' },
    });
    const accountBId = userBLogin.body.account.id;
    assert(accountBId !== accountAId, 'User B has their own account B');

    // Owner of Account A invites User B as developer
    const inviteBRes = await api('/dashboard/team', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { email: userBEmail, role: 'developer' },
    });
    assert(inviteBRes.status === 201, 'Owner invited existing User B as developer (201)');

    // User B fetches /dashboard/me
    const meRes = await api('/dashboard/me', {
      headers: { Authorization: `Bearer ${userBLogin.body.token}` },
    });
    assert(meRes.body.memberships.length === 2, 'User B belongs to both accounts (personal + invited)');
    assert(meRes.body.memberships.some(m => m.accountId === accountAId), 'Membership list includes Account A');
    assert(meRes.body.memberships.some(m => m.accountId === accountBId), 'Membership list includes Account B');

    // -------------------------------------------------------------------------
    // Test 4: Cross-account authorization check (User from B accessing A -> 403)
    // -------------------------------------------------------------------------
    console.log('\n--- Test 4: User without membership requesting account data -> 403 ---');
    const strangerEmail = `stranger_${timestamp}@gmail.com`;
    const strangerSignup = await api('/auth/signup', {
      method: 'POST',
      body: { email: strangerEmail, password: 'Pass1234!' },
    });
    const strangerVerify = strangerSignup.body.verification_link?.split('token=')[1];
    if (strangerVerify) await api(`/auth/verify?token=${strangerVerify}`);

    const strangerLogin = await api('/auth/login', {
      method: 'POST',
      body: { email: strangerEmail, password: 'Pass1234!' },
    });

    const spoofRes = await api('/dashboard/keys', {
      headers: {
        Authorization: `Bearer ${strangerLogin.body.token}`,
        'X-Account-Id': accountAId, // Attempting to access Account A without membership
      },
    });
    assert(spoofRes.status === 403, 'Cross-account access without membership rejected with 403 Forbidden');

    // -------------------------------------------------------------------------
    // Test 5: Unverified email cannot claim pending invite
    // -------------------------------------------------------------------------
    console.log('\n--- Test 5: Unverified email cannot claim pending invite ---');
    const unverifiedEmail = `unverified_${timestamp}@gmail.com`;
    await api('/dashboard/team', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: { email: unverifiedEmail, role: 'viewer' },
    });

    // Unverified signup
    const unverifiedSignup = await api('/auth/signup', {
      method: 'POST',
      body: { email: unverifiedEmail, password: 'Pass1234!' },
    });

    // Try logging in before verifying email
    const prematureLogin = await api('/auth/login', {
      method: 'POST',
      body: { email: unverifiedEmail, password: 'Pass1234!' },
    });
    // Unverified user has no active memberships yet -> /dashboard/me returns 403 or empty
    const unverifiedMe = await api('/dashboard/me', {
      headers: { Authorization: `Bearer ${prematureLogin.body.token}` },
    });
    const unverifiedMemberships = unverifiedMe.body.memberships || [];
    assert(!unverifiedMemberships.some(m => m.accountId === accountAId), 'Unverified email did not claim invite prematurely');

    // Now verify
    const unvToken = unverifiedSignup.body.verification_link?.split('token=')[1];
    await api(`/auth/verify?token=${unvToken}`);

    // Log in after verify
    const verifiedLogin = await api('/auth/login', {
      method: 'POST',
      body: { email: unverifiedEmail, password: 'Pass1234!' },
    });
    assert(verifiedLogin.body.memberships.some(m => m.account_id === accountAId), 'Membership activated immediately upon email verification');

    // -------------------------------------------------------------------------
    // Test 6: Safety Rule: Cannot remove the last active OWNER
    // -------------------------------------------------------------------------
    console.log('\n--- Test 6: Safety Rule: Cannot remove the last active owner ---');
    const teamA = await api('/dashboard/team', {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerMember = teamA.body.data.find(m => m.role === 'owner');

    const removeOwnerRes = await api(`/dashboard/team/${ownerMember.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert(removeOwnerRes.status === 400 && removeOwnerRes.body.error?.code === 'cannot_remove_last_owner', 'Removing the last active owner is rejected (400)');

    // -------------------------------------------------------------------------
    // Test 7: Removing a member revokes access on their next request
    // -------------------------------------------------------------------------
    console.log('\n--- Test 7: Removing a member immediately revokes access ---');
    const dubeMember = teamA.body.data.find(m => m.email.toLowerCase() === dubeEmail.toLowerCase());

    const removeDube = await api(`/dashboard/team/${dubeMember.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert(removeDube.status === 204, 'Member removed by owner (204)');

    const dubeBlockedRes = await api('/dashboard/keys', {
      headers: {
        Authorization: `Bearer ${dubeToken}`,
        'X-Account-Id': accountAId,
      },
    });
    assert(dubeBlockedRes.status === 403, 'Removed member immediately blocked with 403 on next request');

    console.log(`\n================================================================`);
    console.log(`🎉 ALL 7 TEAM MEMBERSHIP & RBAC TESTS PASSED: ${passed} PASSED, ${failed} FAILED`);
    console.log(`================================================================\n`);
  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  } finally {
    process.exit(failed > 0 ? 1 : 0);
  }
}

run();
