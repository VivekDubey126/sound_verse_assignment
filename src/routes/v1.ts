import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { apiKeyAuth } from '../middleware/apiKeyAuth';
import { rateLimiter } from '../middleware/rateLimiter';
import { idempotencyMiddleware } from '../middleware/idempotency';
import {
  createGeneration,
  getGeneration,
  listGenerations,
  cancelGeneration,
  formatGeneration,
} from '../services/generations';
import { getUsageSummary } from '../services/metering';
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  deleteWebhookEndpoint,
} from '../services/webhooks';
import { verifySignedUrl } from '../utils/crypto';
import { BadRequestError, NotFoundError, ForbiddenError } from '../utils/errors';
import { config } from '../config';

export const v1Router = Router();

// ==========================================
// 1. GENERATION API
// ==========================================

// POST /v1/generations
v1Router.post(
  '/generations',
  apiKeyAuth('generations:write'),
  rateLimiter,
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prompt, duration_sec = 30, license = 'royalty_free', instrumental = true, metadata = {} } = req.body;

      if (!prompt || typeof prompt !== 'string') {
        throw new BadRequestError('invalid_prompt', 'A text prompt is required');
      }

      if (typeof duration_sec !== 'number' || duration_sec < 5 || duration_sec > 300) {
        throw new BadRequestError('invalid_duration', 'duration_sec must be between 5 and 300 seconds');
      }

      const ctx = req.apiKeyCtx!;
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

      const generation = await createGeneration({
        accountId: ctx.accountId,
        apiKeyId: ctx.apiKey.id,
        prompt,
        durationSec: duration_sec,
        license,
        instrumental: Boolean(instrumental),
        metadata,
        plan: ctx.plan,
        isTestKey: ctx.keyMode === 'test',
        idempotencyKey,
      });

      res.status(202).json(formatGeneration(generation));
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/generations/:id
v1Router.get(
  '/generations/:id',
  apiKeyAuth('generations:read'),
  rateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = req.apiKeyCtx!;
      const gen = await getGeneration(ctx.accountId, req.params.id);
      res.json(formatGeneration(gen));
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/generations
v1Router.get(
  '/generations',
  apiKeyAuth('generations:read'),
  rateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = req.apiKeyCtx!;
      const status = req.query.status as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

      const result = await listGenerations(ctx.accountId, { status, limit, offset });
      res.json({
        data: result.data.map(formatGeneration),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /v1/generations/:id/cancel
v1Router.post(
  '/generations/:id/cancel',
  apiKeyAuth('generations:write'),
  rateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = req.apiKeyCtx!;
      const gen = await cancelGeneration(ctx.accountId, req.params.id);
      res.json(formatGeneration(gen));
    } catch (err) {
      next(err);
    }
  }
);

// ==========================================
// 2. USAGE API
// ==========================================

// GET /v1/usage
v1Router.get(
  '/usage',
  apiKeyAuth('generations:read'),
  rateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = req.apiKeyCtx!;
      const summary = await getUsageSummary(ctx.accountId, ctx.plan);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  }
);

// ==========================================
// 3. WEBHOOKS API
// ==========================================

// POST /v1/webhook_endpoints
v1Router.post(
  '/webhook_endpoints',
  apiKeyAuth('generations:write'),
  rateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url, events } = req.body;
      if (!url) {
        throw new BadRequestError('missing_url', 'Webhook URL is required');
      }

      const endpoint = await createWebhookEndpoint(req.auth!.accountId, url, events);
      res.status(201).json(endpoint);
    } catch (err) {
      next(err);
    }
  }
);

// GET /v1/webhook_endpoints
v1Router.get(
  '/webhook_endpoints',
  apiKeyAuth('generations:read'),
  rateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const endpoints = await listWebhookEndpoints(req.auth!.accountId);
      res.json({ data: endpoints });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /v1/webhook_endpoints/:id
v1Router.delete(
  '/webhook_endpoints/:id',
  apiKeyAuth('generations:write'),
  rateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteWebhookEndpoint(req.auth!.accountId, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

// ==========================================
// 4. SIGNED AUDIO DELIVERY
// ==========================================

// GET /v1/audio/:file
v1Router.get('/audio/:filename', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filename = req.params.filename;
    const expires = req.query.expires as string;
    const signature = req.query.signature as string;

    if (!expires || !signature) {
      throw new ForbiddenError('missing_signature', 'URL signature and expiration are required');
    }

    const genId = filename.replace(/\.[^/.]+$/, '');
    const valid = verifySignedUrl(genId, expires, signature);
    if (!valid) {
      throw new ForbiddenError('invalid_or_expired_url', 'This audio download URL is invalid or has expired');
    }

    const filePath = path.join(config.storageDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundError('Audio file');
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

