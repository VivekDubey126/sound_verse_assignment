import crypto from 'crypto';

/**
 * Generate a unique generation ID.
 * Format: gen_{10 random alphanumeric chars}
 */
export function generateId(prefix: string = 'gen'): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return `${prefix}_${result}`;
}

/**
 * Generate a UUID v4.
 */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Generate a request ID.
 */
export function requestId(): string {
  return generateId('req');
}

