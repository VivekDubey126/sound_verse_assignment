const express = require('express');
const { authenticate, requireRole } = require('../middleware/authenticate');
const { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } = require('../services/apiKeys');
const { getUsageSummary } = require('../services/metering');
const { getAuditLog } = require('../services/audit');
const { updatePlan, getAccount } = require('../services/accounts');
const { BadRequestError } = require('../utils/errors');

const dashboardRouter = express.Router();

dashboardRouter.use(authenticate);

dashboardRouter.get('/me', async (req, res, next) => {
  try {
    const account = await getAccount(req.auth.accountId);
    res.json({
      account: {
        ...account,
        role: req.auth.role,
        isOwner: req.auth.isOwner,
        userEmail: req.auth.userEmail,
      },
      plan: req.auth.plan,
      role: req.auth.role,
      isOwner: req.auth.isOwner,
      memberships: req.auth.memberships,
    });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post('/plan', requireRole(['owner']), async (req, res, next) => {
  try {
    const { plan } = req.body;
    if (!plan) throw new BadRequestError('missing_plan', 'Plan name required');
    const updated = await updatePlan(req.auth.accountId, plan);
    res.json({ message: 'Plan updated', account: updated });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post('/keys', requireRole(['owner', 'developer']), async (req, res, next) => {
  try {
    const { name, mode = 'live', scopes } = req.body;
    const result = await createApiKey({
      accountId: req.auth.accountId,
      name,
      mode,
      scopes,
    }, req.auth.accountId, req.ip);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get('/keys', async (req, res, next) => {
  try {
    const keys = await listApiKeys(req.auth.accountId);
    res.json({ data: keys });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post('/keys/:id/revoke', requireRole(['owner', 'developer']), async (req, res, next) => {
  try {
    const key = await revokeApiKey(req.auth.accountId, req.params.id, req.auth.accountId, req.ip);
    res.json({ message: 'API key revoked', key });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post('/keys/:id/rotate', requireRole(['owner', 'developer']), async (req, res, next) => {
  try {
    const result = await rotateApiKey(req.auth.accountId, req.params.id, req.auth.accountId, req.ip);
    res.json({ message: 'API key rotated', key: result.key, secret: result.secret });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get('/usage', async (req, res, next) => {
  try {
    const summary = await getUsageSummary(req.auth.accountId, req.auth.plan);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get('/audit', async (req, res, next) => {
  try {
    const logs = await getAuditLog(req.auth.accountId);
    res.json({ data: logs });
  } catch (err) {
    next(err);
  }
});

// Team Members (Roles: owner, developer, viewer)
const { listTeamMembers, addTeamMember, updateTeamMemberRole, removeTeamMember } = require('../services/teams');

dashboardRouter.get('/team', async (req, res, next) => {
  try {
    const members = await listTeamMembers(req.auth.accountId);
    res.json({ data: members });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post('/team', requireRole(['owner']), async (req, res, next) => {
  try {
    const { email, role } = req.body;
    const member = await addTeamMember(req.auth.accountId, email, role, req.auth.accountId);
    res.status(201).json({ message: 'Team member added', member });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.patch('/team/:id/role', requireRole(['owner']), async (req, res, next) => {
  try {
    const { role } = req.body;
    const updated = await updateTeamMemberRole(req.auth.accountId, req.params.id, role, req.auth.accountId);
    res.json({ message: 'Team member role updated', member: updated });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.delete('/team/:id', requireRole(['owner']), async (req, res, next) => {
  try {
    await removeTeamMember(req.auth.accountId, req.params.id, req.auth.accountId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = { dashboardRouter };

