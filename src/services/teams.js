const { getDb } = require('../db/connection');
const { uuid } = require('../utils/crypto');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logAudit } = require('./audit');
const ALLOWED_ROLES = ['owner', 'developer', 'viewer'];
async function listTeamMembers(accountId) {
  const db = getDb();
  const members = db.prepare(`
    SELECT m.id, m.account_id, m.user_id, m.email, m.role, m.status, m.invited_by, m.created_at,
           u.display_name, u.avatar_url
    FROM memberships m
    LEFT JOIN users u ON m.user_id = u.id
    WHERE m.account_id = ?
    ORDER BY m.created_at ASC
  `).all(accountId);

  return members;
}
async function addTeamMember(accountId, email, role = 'viewer', actorId) {
  const db = getDb();

  if (!email || !email.includes('@')) {
    throw new BadRequestError('invalid_email', 'Valid email address is required');
  }

  const cleanEmail = email.toLowerCase().trim();
  const normalizedRole = role.toLowerCase();
  if (!ALLOWED_ROLES.includes(normalizedRole)) {
    throw new BadRequestError('invalid_role', `Role must be one of: ${ALLOWED_ROLES.join(', ')}`);
  }

  // Check if actor is an owner of this account (server-side check)
  if (actorId) {
    const actorMembership = db.prepare(`
      SELECT role FROM memberships 
      WHERE account_id = ? AND (user_id = ? OR email = (SELECT email FROM users WHERE id = ?)) AND status = 'active'
    `).get(accountId, actorId, actorId);

    // If caller has a known membership and is not owner, 403
    if (actorMembership && actorMembership.role !== 'owner') {
      throw new ForbiddenError('forbidden', 'Only account owners can invite team members');
    }
  }

  const existing = db.prepare('SELECT id, status, role FROM memberships WHERE account_id = ? AND lower(email) = ?').get(accountId, cleanEmail);
  if (existing) {
    throw new BadRequestError('member_exists', 'Team member already exists or has pending invite for this account');
  }

  // Check if user already exists in users table to link user_id
  const existingUser = db.prepare('SELECT id, email_verified FROM users WHERE lower(email) = ?').get(cleanEmail);
  const memberId = uuid();
  const now = new Date().toISOString();

  // If user already exists AND is verified, activate immediately; otherwise 'pending'
  const isImmediatelyActive = existingUser && existingUser.email_verified === 1;
  const status = isImmediatelyActive ? 'active' : 'pending';
  const userId = existingUser ? existingUser.id : null;

  db.prepare(`
    INSERT INTO memberships (id, account_id, user_id, email, role, status, invited_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(memberId, accountId, userId, cleanEmail, normalizedRole, status, actorId || accountId, now, now);

  // Sync to legacy team_members table for backwards compat
  try {
    db.prepare('INSERT OR REPLACE INTO team_members (id, account_id, email, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(memberId, accountId, cleanEmail, normalizedRole, now);
  } catch (_) { }

  // Write audit log team_member.invited
  await logAudit({
    accountId,
    actorType: 'user',
    actorId: actorId || accountId,
    action: 'team_member.invited',
    resourceType: 'team_member',
    resourceId: memberId,
    details: { email: cleanEmail, role: normalizedRole, status },
  });

  const inviteLink = `http://localhost:3000/?invite=${memberId}&account=${accountId}`;
  console.log(`\n======================================================`);
  console.log(`✉️  TEAM MEMBER INVITE LINK FOR [${cleanEmail}]:`);
  console.log(`👉 Role: ${normalizedRole.toUpperCase()} | Account: ${accountId}`);
  console.log(`👉 Link: ${inviteLink}`);
  console.log(`======================================================\n`);

  return db.prepare('SELECT * FROM memberships WHERE id = ?').get(memberId);
}

async function removeTeamMember(accountId, memberId, actorId) {
  const db = getDb();
  const member = db.prepare('SELECT * FROM memberships WHERE id = ? AND account_id = ?').get(memberId, accountId);
  if (!member) throw new NotFoundError('Team member');

  // Safety rule: Cannot remove or demote the last active OWNER
  if (member.role === 'owner') {
    const ownerCount = db.prepare(`
      SELECT count(*) as c FROM memberships WHERE account_id = ? AND role = 'owner' AND status = 'active'
    `).get(accountId).c;

    if (ownerCount <= 1) {
      throw new BadRequestError('cannot_remove_last_owner', 'Cannot remove the last active account owner');
    }
  }

  db.prepare('DELETE FROM memberships WHERE id = ?').run(memberId);
  try {
    db.prepare('DELETE FROM team_members WHERE id = ?').run(memberId);
  } catch (_) { }

  await logAudit({
    accountId,
    actorType: 'user',
    actorId: actorId || accountId,
    action: 'team_member.removed',
    resourceType: 'team_member',
    resourceId: memberId,
    details: { email: member.email, role: member.role },
  });
}

module.exports = { listTeamMembers, addTeamMember, removeTeamMember, ALLOWED_ROLES };

