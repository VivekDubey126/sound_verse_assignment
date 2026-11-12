import crypto from 'crypto';
import { config } from '../config';

/**
 * Generate a full API key string.
 * Format: sk_{mode}_{40 random hex chars}
 * Prefix (stored): sk_{mode}_{first 8 hex chars}
 */
export function generateApiKey(mode: 'test' | 'live'): { fullKey: string; prefix: string; hash: string } {
  const randomBytes = crypto.randomBytes(20); // 40 hex chars
  const hex = randomBytes.toString('hex');
  const fullKey = `sk_${mode}_${hex}`;
  const prefix = `sk_${mode}_${hex.slice(0, 8)}`;
  const hash = hashApiKey(fullKey);
  return { fullKey, prefix, hash };
}

/**
 * Hash an API key with SHA-256 for storage/lookup.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Hash a password with bcrypt (imported lazily to avoid top-level await).
 */
export async function hashPassword(password: string): Promise<string> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.hash(password, 12);
}

/**
 * Verify a password against a bcrypt hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.compare(password, hash);
}

/**
 * Generate a signed URL for an audio file.
 */
export function generateSignedUrl(generationId: string, expiresInSec: number = 3600): string {
  const expires = Math.floor(Date.now() / 1000) + expiresInSec;
  const data = `${generationId}:${expires}`;
  const signature = crypto
    .createHmac('sha256', config.apiKeySigningSecret)
    .update(data)
    .digest('hex');
  return `${config.baseUrl}/v1/audio/${generationId}.mp3?expires=${expires}&signature=${signature}`;
}

/**
 * Verify a signed URL.
 */
export function verifySignedUrl(generationId: string, expires: string, signature: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (parseInt(expires, 10) < now) return false;
  const data = `${generationId}:${expires}`;
  const expected = crypto
    .createHmac('sha256', config.apiKeySigningSecret)
    .update(data)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Generate a webhook signing secret.
 */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * Sign a webhook payload.
 */
export function signWebhookPayload(payload: string, secret: string, timestamp: number): string {
  const data = `${timestamp}.${payload}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Hash a request body for idempotency comparison.
 */
export function hashRequestBody(body: any): string {
  const normalized = JSON.stringify(body);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generate an email verification token.
 */
export function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

