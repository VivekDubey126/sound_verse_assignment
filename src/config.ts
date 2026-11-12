import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  // Auth
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
  jwtExpiresIn: '24h',
  apiKeySigningSecret: process.env.API_KEY_SIGNING_SECRET || 'dev-api-key-secret-change-me',

  // Database
  sqlitePath: process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'soundverse.db'),

  // Storage
  storageDir: process.env.STORAGE_DIR || path.join(process.cwd(), 'data', 'audio'),
  signedUrlExpirySec: 3600, // 1 hour

  // Music provider
  musicProvider: process.env.MUSIC_PROVIDER || 'mock',
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  minimaxApiKey: process.env.MINIMAX_API_KEY || '',

  // Mock provider
  mockLatencyMs: parseInt(process.env.MOCK_LATENCY_MS || '2000', 10),
  mockFailureRate: parseFloat(process.env.MOCK_FAILURE_RATE || '0.0'),

  // Webhooks
  webhookMaxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '5', 10),
  webhookTimeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10),

  // Credit costs per license
  creditCosts: {
    royalty_free: 1,
    sync: 6,
    full_ownership: 14,
  } as Record<string, number>,

  // Max audio duration per credit unit (seconds)
  maxDurationPerCredit: 60,
};

