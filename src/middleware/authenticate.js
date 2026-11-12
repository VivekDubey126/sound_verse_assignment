const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { getDb } = require('../db/connection');
const { AuthenticationError, ForbiddenError } = require('../utils/errors');

function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, config.jwtSecret);
    const db = getDb();

    // Find user by userId or email or legacy accountId
    let user = null;
    if (payload.userId) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
    }
    if (!user && payload.email) {
      user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(payload.email.toLowerCase());
    }
    if (!user && payload.accountId) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.accountId);
    }

    const userEmail = (user ? user.email : payload.email || '').toLowerCase().trim();
    const userId = user ? user.id : (payload.userId || payload.accountId);

    // Query active memberships from memberships table
    const activeMemberships = db.prepare(`
      SELECT m.id as membership_id, m.account_id, m.role, m.status, a.email as owner_email, a.plan_name
      FROM memberships m
      JOIN accounts a ON m.account_id = a.id
      WHERE (m.user_id = ? OR lower(m.email) = ?) AND m.status = 'active'
      ORDER BY m.created_at ASC
    `).all(userId, userEmail);

    if (activeMemberships.length === 0) {
      throw new ForbiddenError('no_active_memberships', 'User has no active memberships or accounts');
    }

    // Determine target active account
    // 1. Client passed header X-Account-Id
    // 2. Token payload.accountId
    // 3. First non-owner team invite or first active membership
    const requestedAccountId = req.headers['x-account-id'];
    let activeMembership = null;

    if (requestedAccountId) {
      activeMembership = activeMemberships.find(m => m.account_id === requestedAccountId);
      if (!activeMembership) {
        throw new ForbiddenError('forbidden', 'You do not have active membership in this organization');
      }
    } else if (payload.accountId) {
      activeMembership = activeMemberships.find(m => m.account_id === payload.accountId);
    }

    if (!activeMembership) {
      activeMembership = activeMemberships.find(m => m.role !== 'owner') || activeMemberships[0];
    }

    const targetAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(activeMembership.account_id);
    if (!targetAccount) throw new AuthenticationError('Active account not found');

    const plan = db.prepare('SELECT * FROM plans WHERE name = ?').get(targetAccount.plan_name);
    if (!plan) throw new AuthenticationError('Account plan not found');

    req.auth = {
      accountId: targetAccount.id,
      userId,
      userEmail,
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
  } catch (err) {
    if (err instanceof ForbiddenError) {
      next(err);
    } else {
      next(new AuthenticationError(err.message));
    }
  }
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    const userRole = req.auth?.role || 'viewer';
    if (!allowedRoles.includes(userRole)) {
      return next(new ForbiddenError('insufficient_permissions', `Role '${userRole}' is not authorized to perform this action. Required: ${allowedRoles.join(' or ')}`));
    }
    next();
  };
}

module.exports = { authenticate, requireRole };

