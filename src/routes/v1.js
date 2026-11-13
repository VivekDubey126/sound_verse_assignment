const express = require('express');
const fs = require('fs');
const path = require('path');
const { apiKeyAuth } = require('../middleware/apiKeyAuth');
const { rateLimiter } = require('../middleware/rateLimiter');
const { idempotencyMiddleware } = require('../middleware/idempotency');
const { createGeneration, getGeneration, listGenerations, cancelGeneration, formatGeneration } = require('../services/generations');
const { getUsageSummary } = require('../services/metering');
const { createWebhookEndpoint, listWebhookEndpoints, deleteWebhookEndpoint } = require('../services/webhooks');
const { verifySignedUrl } = require('../utils/crypto');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { config } = require('../config');

const v1Router = express.Router();

// POST /v1/generations
v1Router.post('/generations', apiKeyAuth('generations:write'), rateLimiter, idempotencyMiddleware, async (req, res, next) => {
  try {
    const { prompt, duration_sec = 30, license = 'royalty_free', instrumental = true, metadata = {} } = req.body;
    if (!prompt) throw new BadRequestError('invalid_prompt', 'Text prompt is required');

    const ctx = req.apiKeyCtx;
    const idempotencyKey = req.headers['idempotency-key'];

    const gen = await createGeneration({
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

    res.status(202).json(formatGeneration(gen));
  } catch (err) {
    next(err);
  }
});

// GET /v1/generations/:id
v1Router.get('/generations/:id', apiKeyAuth('generations:read'), rateLimiter, async (req, res, next) => {
  try {
    const gen = await getGeneration(req.apiKeyCtx.accountId, req.params.id);
    res.json(formatGeneration(gen));
  } catch (err) {
    next(err);
  }
});

// GET /v1/generations
v1Router.get('/generations', apiKeyAuth('generations:read'), rateLimiter, async (req, res, next) => {
  try {
    const status = req.query.status;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    const result = await listGenerations(req.apiKeyCtx.accountId, { status, limit, offset });
    res.json({
      data: result.data.map(formatGeneration),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/generations/:id/cancel
v1Router.post('/generations/:id/cancel', apiKeyAuth('generations:write'), rateLimiter, async (req, res, next) => {
  try {
    const gen = await cancelGeneration(req.apiKeyCtx.accountId, req.params.id);
    res.json(formatGeneration(gen));
  } catch (err) {
    next(err);
  }
});

// GET /v1/usage
v1Router.get('/usage', apiKeyAuth('generations:read'), rateLimiter, async (req, res, next) => {
  try {
    const summary = await getUsageSummary(req.apiKeyCtx.accountId, req.apiKeyCtx.plan);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// Webhook endpoints
v1Router.post('/webhook_endpoints', apiKeyAuth('generations:write'), rateLimiter, async (req, res, next) => {
  try {
    const { url, events } = req.body;
    if (!url) throw new BadRequestError('missing_url', 'URL is required');
    const endpoint = await createWebhookEndpoint(req.apiKeyCtx.accountId, url, events);
    res.status(201).json(endpoint);
  } catch (err) {
    next(err);
  }
});

v1Router.get('/webhook_endpoints', apiKeyAuth('generations:read'), rateLimiter, async (req, res, next) => {
  try {
    const endpoints = await listWebhookEndpoints(req.apiKeyCtx.accountId);
    res.json({ data: endpoints });
  } catch (err) {
    next(err);
  }
});

v1Router.delete('/webhook_endpoints/:id', apiKeyAuth('generations:write'), rateLimiter, async (req, res, next) => {
  try {
    await deleteWebhookEndpoint(req.apiKeyCtx.accountId, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Signed audio download
v1Router.get('/audio/:filename', (req, res, next) => {
  try {
    const filename = req.params.filename;
    const expires = req.query.expires;
    const signature = req.query.signature;

    if (!expires || !signature) {
      throw new ForbiddenError('missing_signature', 'Signature and expires required');
    }

    const genId = filename.replace(/\.[^/.]+$/, '');
    if (!verifySignedUrl(genId, expires, signature)) {
      throw new ForbiddenError('invalid_or_expired_url', 'Audio link has expired or signature is invalid');
    }

    const filePath = path.resolve(config.storageDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundError('Audio file');
    }

    // Determine correct MIME type from extension or file header
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === '.wav' ? 'audio/wav' : (ext === '.flac' ? 'audio/flac' : 'audio/mpeg');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

module.exports = { v1Router };

