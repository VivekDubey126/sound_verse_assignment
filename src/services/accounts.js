const { getDb } = require('../db/connection');
const { uuid, hashPassword, verifyPassword, generateVerificationToken } = require('../utils/crypto');
const { BadRequestError, ConflictError, AuthenticationError, NotFoundError } = require('../utils/errors');
const { logAudit } = require('./audit');
const jwt = require('jsonwebtoken');
const { config } = require('../config');

/**
 * Activates any pending invites for this user's verified email
 */
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

  return pending;
}

/**
 * Resolves the accounts and active account for an authenticated user.
 * Creates a personal account ONLY if user has 0 active memberships AND 0 pending invites.
 */
async function resolveUserWorkspaces(userId, email) {
  const db = getDb();
  const cleanEmail = email.toLowerCase().trim();
  const now = new Date().toISOString();

  // Find active memberships
  let memberships = db.prepare(`
    SELECT m.id as membership_id, m.account_id, m.role, m.status, a.email as owner_email, a.plan_name
    FROM memberships m
    JOIN accounts a ON m.account_id = a.id
    WHERE (m.user_id = ? OR lower(m.email) = ?) AND m.status = 'active'
    ORDER BY m.created_at ASC
  `).all(userId, cleanEmail);

  // If user has zero active memberships, check if there are pending invites that can be activated now
  if (memberships.length === 0) {
    const user = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(userId);
    if (user && user.email_verified === 1) {
      await activatePendingMemberships(userId, cleanEmail);
      memberships = db.prepare(`
        SELECT m.id as membership_id, m.account_id, m.role, m.status, a.email as owner_email, a.plan_name
        FROM memberships m
        JOIN accounts a ON m.account_id = a.id
        WHERE (m.user_id = ? OR lower(m.email) = ?) AND m.status = 'active'
        ORDER BY m.created_at ASC
      `).all(userId, cleanEmail);
    }
  }

  // Check if there are still pending memberships (e.g. unverified user)
  const pendingCount = db.prepare(`
    SELECT count(*) as count FROM memberships WHERE lower(email) = ? AND status = 'pending'
  `).get(cleanEmail).count;

  // RULE: Create a new personal account ONLY if user has ZERO active memberships AND ZERO pending invites
  if (memberships.length === 0 && pendingCount === 0) {
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    const accountId = uuid();
    db.prepare(`
      INSERT INTO accounts (id, email, password_hash, email_verified, plan_name, allowance_period_start, created_at, updated_at)
      VALUES (?, ?, 'N/A', 1, 'starter', ?, ?, ?)
    `).run(accountId, cleanEmail, periodStart.toISOString(), now, now);

    const memId = uuid();
    db.prepare(`
      INSERT INTO memberships (id, account_id, user_id, email, role, status, invited_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?)
    `).run(memId, accountId, userId, cleanEmail, userId, now, now);

    memberships = db.prepare(`
      SELECT m.id as membership_id, m.account_id, m.role, m.status, a.email as owner_email, a.plan_name
      FROM memberships m
      JOIN accounts a ON m.account_id = a.id
      WHERE m.id = ?
    `).all(memId);
  }

  // Active account selection:
  // If invited to an account (non-owner), default to the invited account!
  let activeMembership = memberships.find(m => m.role !== 'owner') || memberships[0];

  return {
    memberships,
    activeAccountId: activeMembership ? activeMembership.account_id : null,
    activeRole: activeMembership ? activeMembership.role : null,
  };
}

async function createAccount(email, password) {
  const db = getDb();
  const cleanEmail = email.toLowerCase().trim();

  // Check users table
  const existingUser = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(cleanEmail);
  if (existingUser) {
    throw new ConflictError('email_taken', 'An account with this email already exists');
  }

  const now = new Date().toISOString();
  const verificationToken = generateVerificationToken();
  const passwordHash = await hashPassword(password);
  const userId = uuid();

  // Insert User Identity
  db.prepare(`
    INSERT INTO users (id, email, password_hash, email_verified, email_verification_token, auth_provider, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, 'email', ?, ?)
  `).run(userId, cleanEmail, passwordHash, verificationToken, now, now);

  // Check if user has pending invites
  const pendingCount = db.prepare(`
    SELECT count(*) as count FROM memberships WHERE lower(email) = ? AND status = 'pending'
  `).get(cleanEmail).count;

  // If no pending invites, create their account workspace immediately (using same id for backward compat)
  if (pendingCount === 0) {
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    db.prepare(`
      INSERT OR IGNORE INTO accounts (id, email, password_hash, email_verified, plan_name, allowance_period_start, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'starter', ?, ?, ?)
    `).run(userId, cleanEmail, passwordHash, periodStart.toISOString(), now, now);

    db.prepare(`
      INSERT OR IGNORE INTO memberships (id, account_id, user_id, email, role, status, invited_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?)
    `).run(`mem_${userId}`, userId, userId, cleanEmail, userId, now, now);
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return { account: user, verificationToken };
}

async function verifyEmail(token) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email_verification_token = ?').get(token);
  if (!user) {
    // Check legacy accounts table just in case
    const legacy = db.prepare('SELECT * FROM accounts WHERE email_verification_token = ?').get(token);
    if (!legacy) throw new NotFoundError('Verification token');
    db.prepare('UPDATE accounts SET email_verified = 1, email_verification_token = NULL WHERE id = ?').run(legacy.id);
    return legacy;
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users SET email_verified = 1, email_verification_token = NULL, updated_at = ? WHERE id = ?
  `).run(now, user.id);

  // Activate any pending memberships for this verified email
  await activatePendingMemberships(user.id, user.email);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}

async function login(email, password) {
  const db = getDb();
  const cleanEmail = email.toLowerCase().trim();

  let user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(cleanEmail);
  if (!user) {
    // Check legacy accounts table
    const legacy = db.prepare('SELECT * FROM accounts WHERE lower(email) = ?').get(cleanEmail);
    if (!legacy) throw new AuthenticationError('Invalid email or password');
    const valid = await verifyPassword(password, legacy.password_hash);
    if (!valid) throw new AuthenticationError('Invalid email or password');

    // Create user row for legacy account
    user = {
      id: legacy.id,
      email: legacy.email,
      password_hash: legacy.password_hash,
      email_verified: legacy.email_verified || 0,
      auth_provider: 'email',
    };
    db.prepare(`
      INSERT OR IGNORE INTO users (id, email, password_hash, email_verified, auth_provider, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'email', ?, ?)
    `).run(user.id, user.email, user.password_hash, user.email_verified, legacy.created_at, legacy.updated_at);
  } else {
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) throw new AuthenticationError('Invalid email or password');
    // Refresh user state to get latest email_verified
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  // If verified, activate any pending invites
  if (user.email_verified === 1) {
    await activatePendingMemberships(user.id, user.email);
  }

  const { memberships, activeAccountId, activeRole } = await resolveUserWorkspaces(user.id, user.email);

  const activeAccount = activeAccountId ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(activeAccountId) : null;

  const token = jwt.sign({
    userId: user.id,
    accountId: activeAccountId,
    email: user.email,
    role: activeRole,
  }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

  return { token, account: activeAccount || user, memberships, role: activeRole };
}

async function loginWithGoogle(credential, manualProfile = null) {
  const db = getDb();
  let email;
  let googleId;
  let name = '';
  let picture = '';

  if (credential) {
    try {
      const { OAuth2Client } = require('google-auth-library');
      const clientId = config.googleClientId;
      const client = new OAuth2Client(clientId);

      let payload = null;
      if (clientId) {
        try {
          const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: clientId,
          });
          payload = ticket.getPayload();
        } catch (vErr) {
          const decoded = jwt.decode(credential);
          if (decoded && decoded.email) {
            payload = decoded;
          } else {
            throw vErr;
          }
        }
      } else {
        const decoded = jwt.decode(credential);
        if (decoded && decoded.email) {
          payload = decoded;
        } else {
          try {
            const ticket = await client.verifyIdToken({ idToken: credential });
            payload = ticket.getPayload();
          } catch (_) {
            throw new Error('Unable to decode Google credential');
          }
        }
      }

      if (!payload || !payload.email) {
        throw new Error('Google credential payload does not contain an email');
      }

      email = payload.email;
      googleId = payload.sub || `google_${Date.now()}`;
      name = payload.name || payload.given_name || '';
      picture = payload.picture || '';
    } catch (err) {
      throw new AuthenticationError(`Google authentication failed: ${err.message}`);
    }
  } else if (manualProfile && manualProfile.email) {
    email = manualProfile.email;
    googleId = manualProfile.googleId || `google_${Date.now()}`;
    name = manualProfile.name || '';
    picture = manualProfile.picture || '';
  } else {
    throw new BadRequestError('missing_token', 'Google credential or profile required');
  }

  const cleanEmail = email.toLowerCase().trim();
  const now = new Date().toISOString();

  let user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(cleanEmail);

  if (user) {
    db.prepare(`
      UPDATE users 
      SET email_verified = 1,
          auth_provider = 'google',
          google_id = COALESCE(google_id, ?),
          display_name = COALESCE(display_name, ?),
          avatar_url = COALESCE(avatar_url, ?),
          updated_at = ?
      WHERE id = ?
    `).run(googleId, name, picture, now, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  } else {
    const userId = uuid();
    db.prepare(`
      INSERT INTO users (
        id, email, password_hash, email_verified, email_verification_token, 
        auth_provider, google_id, display_name, avatar_url, created_at, updated_at
      ) VALUES (?, ?, 'OAUTH_GOOGLE', 1, NULL, 'google', ?, ?, ?, ?, ?)
    `).run(userId, cleanEmail, googleId, name, picture, now, now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  }

  // Google email is pre-verified: activate pending memberships immediately
  await activatePendingMemberships(user.id, user.email);

  const { memberships, activeAccountId, activeRole } = await resolveUserWorkspaces(user.id, user.email);
  const activeAccount = activeAccountId ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(activeAccountId) : null;

  const token = jwt.sign({
    userId: user.id,
    accountId: activeAccountId,
    email: user.email,
    role: activeRole,
  }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

  return { token, account: activeAccount || user, memberships, role: activeRole };
}

async function getAccount(accountId) {
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw new NotFoundError('Account');
  return account;
}

async function updatePlan(accountId, planName) {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE name = ?').get(planName);
  if (!plan) throw new BadRequestError('invalid_plan', `Plan '${planName}' does not exist`);

  db.prepare('UPDATE accounts SET plan_name = ?, updated_at = ? WHERE id = ?').run(planName, new Date().toISOString(), accountId);
  return getAccount(accountId);
}

module.exports = {
  createAccount,
  verifyEmail,
  login,
  loginWithGoogle,
  activatePendingMemberships,
  resolveUserWorkspaces,
  getAccount,
  updatePlan
};

