const path = require('path');
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-soundverse-2026',
  jwtExpiresIn: '24h',
  apiKeySigningSecret: process.env.API_KEY_SIGNING_SECRET || 'dev-api-key-signing-secret',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',

  sqlitePath: process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'soundverse.db'),
  storageDir: process.env.STORAGE_DIR || path.join(process.cwd(), 'data', 'audio'),

  musicProvider: process.env.MUSIC_PROVIDER || 'mock',
  mockLatencyMs: parseInt(process.env.MOCK_LATENCY_MS || '1500', 10),
  mockFailureRate: parseFloat(process.env.MOCK_FAILURE_RATE || '0.0'),

  creditCosts: {
    royalty_free: 1,
    sync: 6,
    full_ownership: 14,
  },
  maxDurationPerCredit: 60,
};

module.exports = { config };

