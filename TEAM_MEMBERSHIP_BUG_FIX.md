# Multi-Tenant Team Membership Bug & Architecture Fix — In-Depth Post-Mortem

**Author:** Soundverse Enterprise Engineering  
**Scope:** Multi-Tenant Organization Isolation, Team Memberships, Role-Based Access Control (RBAC), and Authentication Lifecycles.  
**File Reference:** `TEAM_MEMBERSHIP_BUG_FIX.md`

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [The Reported Bug & Real-World User Scenario](#2-the-reported-bug--real-world-user-scenario)
3. [Deep-Dive Root Cause Analysis](#3-deep-dive-root-cause-analysis)
   - [3.1 The Flawed 1:1 Identity/Workspace Paradigm](#31-the-flawed-11-identityworkspace-paradigm)
   - [3.2 The Unconditional Account Creation Loophole](#32-the-unconditional-account-creation-loophole)
   - [3.3 Session Token Anchoring Disconnect](#33-session-token-anchoring-disconnect)
4. [The Architectural Solution](#4-the-architectural-solution)
   - [4.1 Normalized Relational Schema (`users`, `accounts`, `memberships`)](#41-normalized-relational-schema-users-accounts-memberships)
   - [4.2 The Invitation Lifecycle State Machine](#42-the-invitation-lifecycle-state-machine)
   - [4.3 Zero-Redundancy Account Creation Rules](#43-zero-redundancy-account-creation-rules)
   - [4.4 Active Workspace Resolution & Multi-Workspace Switching](#44-active-workspace-resolution--multi-workspace-switching)
5. [Server-Side Role-Based Access Control (RBAC)](#5-server-side-role-based-access-control-rbac)
   - [5.1 Role Matrix: OWNER vs DEVELOPER vs VIEWER](#51-role-matrix-owner-vs-developer-vs-viewer)
   - [5.2 Middleware-Level Enforcement: `authenticate` & `requireRole`](#52-middleware-level-enforcement-authenticate--requirerole)
   - [5.3 Critical Safety Constraints & Edge Cases](#53-critical-safety-constraints--edge-cases)
6. [Code Level Implementation Walkthrough](#6-code-level-implementation-walkthrough)
   - [6.1 Database Schema (`src/db/connection.js`)](#61-database-schema-srcdbconnectionjs)
   - [6.2 Invitation Service (`src/services/teams.js`)](#62-invitation-service-srcservicesteamsjs)
   - [6.3 Authentication & Auto-Activation (`src/services/accounts.js`)](#63-authentication--auto-activation-srcservicesaccountsjs)
   - [6.4 Request Context Authentication (`src/middleware/authenticate.js`)](#64-request-context-authentication-srcmiddlewareauthenticatejs)
   - [6.5 Frontend Workspace Switcher (`public/index.html`)](#65-frontend-workspace-switcher-publicindexhtml)
7. [Comprehensive Test Verification Suite](#7-comprehensive-test-verification-suite)
   - [7.1 Test Scenarios & Assertion Results](#71-test-scenarios--assertion-results)
   - [7.2 Acceptance Test Regression Check](#72-acceptance-test-regression-check)
8. [Conclusion & Key Takeaways](#8-conclusion--key-takeaways)

---

## 1. Executive Summary

In multi-tenant SaaS platforms, the distinction between a **User Identity** (who you are, how you authenticate) and a **Workspace/Account** (the billing boundary, API keys, quota, and resources) is critical.

A major isolation defect was uncovered: when an account owner (`noob4coder@gmail.com`) invited an employee (`dubeprince024@gmail.com`) to collaborate in Organization Workspace A, the employee's initial login created a completely separate personal workspace with an empty starter plan. The employee was completely disconnected from Organization A.

This document outlines the root cause, the normalized schema refactoring, the invite-activation state machine, the server-side RBAC security model, and automated test proof verifying 100% resolution.

---

## 2. The Reported Bug & Real-World User Scenario

### User Flow:
1. **Owner (`noob4coder@gmail.com`)** signs up on the Soundverse Enterprise platform. An account workspace (Account A) is created on the `Starter` plan (200 monthly credits).
2. The Owner creates API keys, triggers music generations, and uses 45 credits.
3. The Owner navigates to the **Team Members** section and invites an employee (`dubeprince024@gmail.com`) with the role `VIEWER`.
4. The Employee visits `http://localhost:3000` and clicks **Continue with Google** (or signs up via password).
5. **The Glitch:** The employee logs in and sees an empty dashboard:
   - 0 API keys.
   - Fresh 200/200 monthly credits (brand-new allowance).
   - 0 generation jobs in the table.
   - None of Account A's team members or audit logs.

### Expected Behavior:
The employee (`dubeprince024@gmail.com`) should have logged straight into Account A's workspace with the assigned role (`VIEWER`), viewing Account A's API keys, audio history, allowance, and audit logs in read-only mode, without auto-generating a redundant empty account.

---

## 3. Deep-Dive Root Cause Analysis

### 3.1 The Flawed 1:1 Identity/Workspace Paradigm
In the initial version of `src/db/connection.js`, human identity credentials and workspace billing were conflated into a single `accounts` table:

```sql
-- LEGACY FLAWED TABLE
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                       -- Used as Account ID AND User ID
  email TEXT UNIQUE NOT NULL,                -- User login email
  password_hash TEXT NOT NULL,               -- User credential
  email_verified INTEGER DEFAULT 0,          -- User verification
  plan_name TEXT NOT NULL DEFAULT 'sandbox', -- Billing workspace property
  allowance_period_start TEXT,               -- Billing workspace property
  ...
);
```

Because `accounts` represented both the user and the workspace:
- An "account" could only have one email address.
- A user could only belong to exactly one account.
- A user could never belong to multiple organizations or distinguish between their personal workspace and their employer's workspace.

### 3.2 The Unconditional Account Creation Loophole
Look at what `src/services/accounts.js` was doing upon signup or Google login:

```javascript
// LEGACY CODE IN loginWithGoogle & createAccount:
let account = db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);

if (!account) {
  // CRITICAL FLAW: Generates a new account workspace without checking 
  // if this email was invited to an existing organization!
  const accountId = uuid();
  db.prepare(`
    INSERT INTO accounts (id, email, password_hash, plan_name, ...)
    VALUES (?, ?, 'OAUTH_GOOGLE', 'starter', ...)
  `).run(accountId, email, ...);
}
```

The code operated on a blind assumption:
> *"If this email doesn't have an account row, generate a new account workspace and give them the starter plan."*

It completely ignored whether `dubeprince024@gmail.com` had an active or pending invitation in `team_members`.

### 3.3 Session Token Anchoring Disconnect
When the JWT was generated:
```javascript
const token = jwt.sign({ accountId: account.id, email: account.email }, config.jwtSecret);
```
The session token was permanently anchored to the freshly generated personal `accountId`. Whenever the frontend requested `/dashboard/me`, `/dashboard/keys`, or `/dashboard/usage`, the backend loaded data filtered by `WHERE account_id = req.auth.accountId`—querying the brand-new empty workspace.

---

## 4. The Architectural Solution

To resolve this permanently and cleanly, the platform was refactored into a **Normalized Multi-Tenant Architecture**.

### 4.1 Normalized Relational Schema (`users`, `accounts`, `memberships`)

```
 ┌──────────────────────┐         ┌────────────────────────┐         ┌──────────────────────┐
 │        users         │         │      memberships       │         │       accounts       │
 ├──────────────────────┤         ├────────────────────────┤         ├──────────────────────┤
 │ id (PK)              │1       *│ id (PK)                │*       1│ id (PK)              │
 │ email (UNIQUE, lower)│◄────────┤ user_id (FK, nullable) │────────►│ name                 │
 │ password_hash        │         │ account_id (FK)        │         │ plan_name            │
 │ email_verified       │         │ email (lower)          │         │ allowance_period_... │
 │ auth_provider        │         │ role (owner/dev/viewer)│         │ created_at           │
 │ display_name         │         │ status (pending/active)│         │ updated_at           │
 │ created_at           │         │ invited_by             │         └──────────────────────┘
 └──────────────────────┘         │ UNIQUE(account, email) │
                                  └────────────────────────┘
```

1. **`users` Table (Identity):**
   Stores who the user is, how they sign in (password hash or Google OAuth ID), and whether their email has been verified.
2. **`accounts` Table (Workspace & Billing):**
   Stores the workspace entity, subscription plan (`sandbox`, `starter`, `growth`), monthly allowance periods, API keys, usage ledger, and audio generation history.
3. **`memberships` Table (Authorization & Tenancy):**
   Establishes a many-to-many relationship linking a user/email to a workspace with an explicit role (`owner`, `developer`, `viewer`) and invite lifecycle status (`pending`, `active`).

### 4.2 The Invitation Lifecycle State Machine

```
                    Owner Invites User
                            │
                            ▼
              ┌───────────────────────────┐
              │     STATUS: 'pending'     │
              │  (user_id may be NULL)    │
              └─────────────┬─────────────┘
                            │
               User Authenticates & Verifies
                            │
                            ▼
              ┌───────────────────────────┐
              │     STATUS: 'active'      │
              │   (user_id = user.id)     │
              └─────────────┬─────────────┘
                            │
                   Owner Removes Member
                            │
                            ▼
              ┌───────────────────────────┐
              │     RECORD DELETED        │
              │ (Immediate 403 on next req)│
              └───────────────────────────┘
```

1. **Step 1 — Pending Invite:** When the owner invites `dubeprince024@gmail.com`, a membership row is written:
   - `account_id = Account A`
   - `email = 'dubeprince024@gmail.com'`
   - `role = 'viewer'`
   - `status = 'pending'`
   - `invited_by = Owner ID`
   - Audit Log Event: `team_member.invited`
2. **Step 2 — Auto-Activation on Login/Signup:**
   When the employee authenticates (Google login or verified email signup), the authentication pipeline searches `memberships WHERE lower(email) = ? AND status = 'pending'`.
   It automatically sets:
   - `user_id = user.id`
   - `status = 'active'`
   - Audit Log Event: `team_member.joined`

### 4.3 Zero-Redundancy Account Creation Rules
To prevent creating useless empty workspaces, `src/services/accounts.js` enforces the **Zero-Redundancy Invariant**:

$$\text{Create Personal Account} \iff (\text{Active Memberships} = 0) \land (\text{Pending Invites} = 0)$$

- If an employee was invited to Account A:
  - $\text{Pending Invites} \ge 1 \implies$ **No personal account is created**.
  - The employee immediately lands directly in Account A with role `VIEWER`.
- If an independent developer signs up from scratch:
  - $\text{Active Memberships} = 0 \land \text{Pending Invites} = 0 \implies$ A personal workspace is created, and an `OWNER` membership is assigned.

### 4.4 Active Workspace Resolution & Multi-Workspace Switching
What happens if an existing developer who already has their own personal workspace gets invited to a company's team?
- The user belongs to **both** workspaces.
- In `src/middleware/authenticate.js`, the active workspace is resolved via:
  1. Priority 1: Client header `X-Account-Id` (verified against user's active memberships).
  2. Priority 2: Token payload `accountId`.
  3. Priority 3: Non-owner invited team workspace (so newly invited users see their employer's team first).
  4. Priority 4: Personal account.
- The dashboard UI includes an **Organization/Workspace Switcher** in the top navigation header:
  ```html
  <select id="workspaceSelector" onchange="switchWorkspace(this.value)">
    <option value="acc_1">🏢 company@soundverse.ai (VIEWER)</option>
    <option value="acc_2">👑 Personal Workspace (OWNER)</option>
  </select>
  ```
  Switching updates `localStorage.setItem('soundverse_account_id', selectedId)`, passing `X-Account-Id` on all subsequent API requests.

---

## 5. Server-Side Role-Based Access Control (RBAC)

UI visual affordances (hiding buttons or greying out fields) are insufficient for enterprise security. Every mutating API route strictly enforces server-side role checks.

### 5.1 Role Matrix: OWNER vs DEVELOPER vs VIEWER

| Action / API Endpoint | OWNER | DEVELOPER | VIEWER |
| :--- | :---: | :---: | :---: |
| **View Dashboard, Usage & Allowance** (`GET /dashboard/usage`) | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| **View API Keys & History** (`GET /dashboard/keys`) | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| **View Audit Logs** (`GET /dashboard/audit`) | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| **View Generation History & Audio** (`GET /v1/generations`) | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| **Create New API Keys** (`POST /dashboard/keys`) | ✅ Allowed | ✅ Allowed | ❌ **403 Forbidden** |
| **Revoke / Rotate API Keys** (`POST /dashboard/keys/:id/*`) | ✅ Allowed | ✅ Allowed | ❌ **403 Forbidden** |
| **Trigger Audio Generations** (`POST /v1/generations`) | ✅ Allowed | ✅ Allowed | ❌ **403 Forbidden** |
| **Change Subscription Plan** (`POST /dashboard/plan`) | ✅ Allowed | ❌ **403 Forbidden** | ❌ **403 Forbidden** |
| **Invite New Team Members** (`POST /dashboard/team`) | ✅ Allowed | ❌ **403 Forbidden** | ❌ **403 Forbidden** |
| **Remove Team Members** (`DELETE /dashboard/team/:id`) | ✅ Allowed | ❌ **403 Forbidden** | ❌ **403 Forbidden** |

### 5.2 Middleware-Level Enforcement: `authenticate` & `requireRole`
In `src/middleware/authenticate.js`:
```javascript
function requireRole(allowedRoles) {
  return (req, res, next) => {
    const userRole = req.auth?.role || 'viewer';
    if (!allowedRoles.includes(userRole)) {
      return next(new ForbiddenError(
        'insufficient_permissions',
        `Role '${userRole}' is not authorized to perform this action. Required: ${allowedRoles.join(' or ')}`
      ));
    }
    next();
  };
}
```

In `src/routes/dashboard.js`:
```javascript
dashboardRouter.post('/plan', requireRole(['owner']), ...);
dashboardRouter.post('/team', requireRole(['owner']), ...);
dashboardRouter.delete('/team/:id', requireRole(['owner']), ...);
dashboardRouter.post('/keys', requireRole(['owner', 'developer']), ...);
dashboardRouter.post('/keys/:id/revoke', requireRole(['owner', 'developer']), ...);
dashboardRouter.post('/keys/:id/rotate', requireRole(['owner', 'developer']), ...);
```

### 5.3 Critical Safety Constraints & Edge Cases
1. **Never Remove the Last Active Owner:**
   If an owner attempts to delete their own membership or another owner when `count(active_owners) <= 1`, the server rejects the request with `400 Bad Request` (`cannot_remove_last_owner`). An account can never be left orphaned without an owner.
2. **Immediate Access Revocation:**
   Removing a team member from `memberships` takes effect on their **very next HTTP request**. Even if the user still holds an unexpired JWT, `authenticate.js` queries `memberships` in real time. Because the row no longer exists, the request is immediately rejected with `403 Forbidden`.
3. **Cross-Tenant Spoofing Prevention:**
   If User B discovers Account A's UUID and sends `X-Account-Id: <Account_A_UUID>`, `authenticate.js` cross-references `memberships` for `(user_id, account_id)`. Because User B has no active membership in Account A, the request fails with `403 Forbidden: You do not have active membership in this organization`.
4. **Case-Insensitive Email Matching:**
   Email invitations are sanitized via `lower(trim(email))`. An invitation sent to `DubePrince024@Gmail.Com` seamlessly matches Google OAuth profile `dubeprince024@gmail.com`.

---

## 6. Code Level Implementation Walkthrough

### 6.1 Database Schema (`src/db/connection.js`)
```javascript
// Migration: create users and memberships tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email_verified INTEGER DEFAULT 0,
    email_verification_token TEXT,
    auth_provider TEXT DEFAULT 'email',
    google_id TEXT,
    display_name TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    user_id TEXT,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    status TEXT NOT NULL DEFAULT 'active',
    invited_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, email)
  );
`);
```

### 6.2 Invitation Service (`src/services/teams.js`)
```javascript
async function addTeamMember(accountId, email, role = 'viewer', actorId) {
  const db = getDb();
  const cleanEmail = email.toLowerCase().trim();

  // Server-side check: Actor must be OWNER of this account
  if (actorId) {
    const actorMembership = db.prepare(`
      SELECT role FROM memberships 
      WHERE account_id = ? AND (user_id = ? OR email = (SELECT email FROM users WHERE id = ?)) AND status = 'active'
    `).get(accountId, actorId, actorId);

    if (actorMembership && actorMembership.role !== 'owner') {
      throw new ForbiddenError('forbidden', 'Only account owners can invite team members');
    }
  }

  // Check if user already exists and is verified
  const existingUser = db.prepare('SELECT id, email_verified FROM users WHERE lower(email) = ?').get(cleanEmail);
  const status = (existingUser && existingUser.email_verified === 1) ? 'active' : 'pending';
  const userId = existingUser ? existingUser.id : null;

  const memberId = uuid();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO memberships (id, account_id, user_id, email, role, status, invited_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(memberId, accountId, userId, cleanEmail, role.toLowerCase(), status, actorId || accountId, now, now);

  await logAudit({
    accountId,
    actorType: 'user',
    actorId: actorId || accountId,
    action: 'team_member.invited',
    resourceType: 'team_member',
    resourceId: memberId,
    details: { email: cleanEmail, role: role.toLowerCase(), status },
  });

  return db.prepare('SELECT * FROM memberships WHERE id = ?').get(memberId);
}
```

### 6.3 Authentication & Auto-Activation (`src/services/accounts.js`)
```javascript
async function activatePendingMemberships(userId, email) {
  const db = getDb();
  const cleanEmail = email.toLowerCase().trim();
  const now = new Date().toISOString();

  const pending = db.prepare(`
    SELECT * FROM memberships WHERE lower(email) = ? AND status = 'pending'
  `).all(cleanEmail);

  for (const m of pending) {
    db.prepare(`
      UPDATE memberships SET user_id = ?, status = 'active', updated_at = ? WHERE id = ?
    `).run(userId, now, m.id);

    await logAudit({
      accountId: m.account_id,
      actorType: 'user',
      actorId: userId,
      action: 'team_member.joined',
      resourceType: 'team_member',
      resourceId: m.id,
      details: { email: cleanEmail, role: m.role },
    });
  }
}
```

### 6.4 Request Context Authentication (`src/middleware/authenticate.js`)
```javascript
function authenticate(req, res, next) {
  const token = req.headers.authorization.slice(7);
  const payload = jwt.verify(token, config.jwtSecret);
  const db = getDb();

  const user = db.prepare('SELECT * FROM users WHERE id = ? OR lower(email) = ?')
    .get(payload.userId || payload.accountId, (payload.email || '').toLowerCase());

  // Query active memberships in real-time
  const activeMemberships = db.prepare(`
    SELECT m.id as membership_id, m.account_id, m.role, m.status, a.email as owner_email, a.plan_name
    FROM memberships m
    JOIN accounts a ON m.account_id = a.id
    WHERE (m.user_id = ? OR lower(m.email) = ?) AND m.status = 'active'
    ORDER BY m.created_at ASC
  `).all(user.id, user.email);

  if (activeMemberships.length === 0) {
    throw new ForbiddenError('no_active_memberships', 'User has no active memberships or accounts');
  }

  // Resolve requested workspace via X-Account-Id or default to team account
  const requestedAccountId = req.headers['x-account-id'];
  let activeMembership = requestedAccountId 
    ? activeMemberships.find(m => m.account_id === requestedAccountId)
    : (activeMemberships.find(m => m.role !== 'owner') || activeMemberships[0]);

  if (!activeMembership) {
    throw new ForbiddenError('forbidden', 'You do not have active membership in this organization');
  }

  const targetAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(activeMembership.account_id);
  const plan = db.prepare('SELECT * FROM plans WHERE name = ?').get(targetAccount.plan_name);

  req.auth = {
    accountId: targetAccount.id,
    userId: user.id,
    userEmail: user.email,
    account: targetAccount,
    plan,
    role: activeMembership.role,
    isOwner: activeMembership.role === 'owner',
    memberships: activeMemberships.map(m => ({
      accountId: m.account_id,
      ownerEmail: m.owner_email,
      role: m.role,
      isOwner: m.role === 'owner',
    })),
  };
  next();
}
```

---

## 7. Comprehensive Test Verification Suite

A dedicated automated test harness was built and executed in `tests/test-team-memberships.js` to rigorously validate all requirements.

### 7.1 Test Scenarios & Assertion Results

```
🧪 Starting Team Membership & RBAC Test Suite against live server...

--- Test 1: Owner invites X; X signs up fresh -> X sees owner account, role VIEWER, no personal account ---
  ✅ PASS: Owner logged in successfully
  ✅ PASS: Owner successfully invited member as VIEWER (201)
  ✅ PASS: Dube signed in via Google (200)
  ✅ PASS: Invited user Dube lands directly in Owner Account A!
  ✅ PASS: Dube role is VIEWER
  ✅ PASS: Dube has exactly 1 membership (no redundant personal account)

--- Test 2: VIEWER cannot create keys, change plan, or invite members (403) ---
  ✅ PASS: VIEWER blocked from creating API key (403)
  ✅ PASS: VIEWER blocked from updating plan (403)
  ✅ PASS: VIEWER blocked from managing team members (403)

--- Test 3: Existing user with own account is invited -> belongs to both ---
  ✅ PASS: User B has their own account B
  ✅ PASS: Owner invited existing User B as developer (201)
  ✅ PASS: User B belongs to both accounts (personal + invited)
  ✅ PASS: Membership list includes Account A
  ✅ PASS: Membership list includes Account B

--- Test 4: User without membership requesting account data -> 403 ---
  ✅ PASS: Cross-account access without membership rejected with 403 Forbidden

--- Test 5: Unverified email cannot claim pending invite ---
  ✅ PASS: Unverified email did not claim invite prematurely
  ✅ PASS: Membership activated immediately upon email verification

--- Test 6: Safety Rule: Cannot remove the last active owner ---
  ✅ PASS: Removing the last active owner is rejected (400)

--- Test 7: Removing a member immediately revokes access ---
  ✅ PASS: Member removed by owner (204)
  ✅ PASS: Removed member immediately blocked with 403 on next request

================================================================
🎉 ALL 7 TEAM MEMBERSHIP & RBAC TESTS PASSED: 20 PASSED, 0 FAILED
================================================================
```

### 7.2 Acceptance Test Regression Check
Running `tests/run-all.js` confirms that all 14 assignment acceptance scenarios continue to pass seamlessly with **30 PASSED, 0 FAILED**.

---

## 8. Conclusion & Key Takeaways

1. **Identity $\ne$ Workspace:** Conflating users and accounts in a single table is the number one cause of broken invitation flows in SaaS backends. Decoupling them through an explicit `memberships` junction table is mandatory.
2. **Invite-First Resolution:** Never create personal workspace accounts on signup without checking for existing invitations. An invited employee should land in their organization immediately upon their first login.
3. **Defense in Depth:** Disabling buttons in the UI provides a pleasant UX, but real enterprise security relies on server-side middleware (`requireRole`) verifying real-time database state on every single request.
4. **Audio Streaming Path Fix:** Ensuring `path.resolve` is used for `res.sendFile` guarantees that audio files stream cleanly to HTML5 players across all operating systems.

The platform is running live at **`http://localhost:3000`** with full multi-tenant organization support and real Google OAuth.
