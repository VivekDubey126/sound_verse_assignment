import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/authenticate';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from '../services/apiKeys';
import { getUsageSummary } from '../services/metering';
import { getAuditLog } from '../services/audit';
import { updatePlan, getAccount } from '../services/accounts';
import { BadRequestError } from '../utils/errors';

export const dashboardRouter = Router();

// Protect all dashboard routes with JWT auth
dashboardRouter.use(authenticate);

// Account & Plan
dashboardRouter.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await getAccount(req.auth!.accountId);
    res.json({
      account: {
        id: account.id,
        email: account.email,
        plan: account.plan_name,
        email_verified: Boolean(account.email_verified),
        created_at: account.created_at,
      },
      plan: req.auth!.plan,
    });
  } catch (err) {
    next(err);
  }
});

// Change Plan (admin / self-serve upgrade)
dashboardRouter.post('/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { plan } = req.body;
    if (!plan) throw new BadRequestError('missing_plan', 'Plan name is required');
    const updated = await updatePlan(req.auth!.accountId, plan);
    res.json({ message: 'Plan updated', account: updated });
  } catch (err) {
    next(err);
  }
});

// API Keys
dashboardRouter.post('/keys', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, mode = 'live', scopes } = req.body;
    if (mode !== 'test' && mode !== 'live') {
      throw new BadRequestError('invalid_mode', "Mode must be 'test' or 'live'");
    }

    const result = await createApiKey(
      {
        accountId: req.auth!.accountId,
        name,
        mode,
        scopes,
      },
      req.auth!.accountId,
      req.ip
    );

    // Secret is returned exactly once
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

dashboardRouter.get('/keys', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const keys = await listApiKeys(req.auth!.accountId);
    res.json({ data: keys });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post('/keys/:id/revoke', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const revoked = await revokeApiKey(req.auth!.accountId, req.params.id, req.auth!.accountId, req.ip);
    res.json({ message: 'API key revoked', key: revoked });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post('/keys/:id/rotate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await rotateApiKey(req.auth!.accountId, req.params.id, req.auth!.accountId, req.ip);
    res.json({
      message: 'API key rotated. Old key revoked, new key active.',
      key: result.key,
      secret: result.secret,
    });
  } catch (err) {
    next(err);
  }
});

// Usage
dashboardRouter.get('/usage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await getUsageSummary(req.auth!.accountId, req.auth!.plan);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// Audit Log
dashboardRouter.get('/audit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const logs = await getAuditLog(req.auth!.accountId, { limit, offset });
    res.json({ data: logs });
  } catch (err) {
    next(err);
  }
});

