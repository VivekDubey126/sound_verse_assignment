const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { config } = require('../config');

function generateApiKey(mode) {
  const randomHex = crypto.randomBytes(20).toString('hex');
  const fullKey = `sk_${mode}_${randomHex}`;
  const prefix = `sk_${mode}_${randomHex.slice(0, 8)}`;
  const hash = hashApiKey(fullKey);
  return { fullKey, prefix, hash };
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function generateSignedUrl(generationId, expiresInSec = 3600) {
  const expires = Math.floor(Date.now() / 1000) + expiresInSec;
  const data = `${generationId}:${expires}`;
  const signature = crypto.createHmac('sha256', config.apiKeySigningSecret).update(data).digest('hex');
  return `${config.baseUrl}/v1/audio/${generationId}.mp3?expires=${expires}&signature=${signature}`;
}

function verifySignedUrl(generationId, expires, signature) {
  const now = Math.floor(Date.now() / 1000);
  if (parseInt(expires, 10) < now) return false;
  const data = `${generationId}:${expires}`;
  const expected = crypto.createHmac('sha256', config.apiKeySigningSecret).update(data).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

function signWebhookPayload(payload, secret, timestamp) {
  const data = `${timestamp}.${payload}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function hashRequestBody(body) {
  const normalized = JSON.stringify(body || {});
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

function uuid() {
  return crypto.randomUUID();
}

function generateId(prefix = 'gen') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  generateApiKey,
  hashApiKey,
  hashPassword,
  verifyPassword,
  generateSignedUrl,
  verifySignedUrl,
  generateWebhookSecret,
  signWebhookPayload,
  hashRequestBody,
  generateVerificationToken,
  uuid,
  generateId,
};

