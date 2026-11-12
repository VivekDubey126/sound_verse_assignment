const fs = require('fs');
const path = require('path');
const { createApp } = require('./app');
const { initDb } = require('./db/connection');
const { startWorker } = require('./services/worker');
const { config } = require('./config');

async function main() {
  console.log('🚀 Initializing Soundverse Enterprise API Platform...');

  const dataDir = path.dirname(config.sqlitePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(config.storageDir)) {
    fs.mkdirSync(config.storageDir, { recursive: true });
  }

  // Initialize SQLite with WAL mode & seed plans
  initDb();
  console.log('📦 Database initialized & plans ready.');

  // Start background worker for async jobs & webhooks
  startWorker();
  console.log('⚙️  Background generation & webhook workers started.');

  // Start Express server
  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n================================================================`);
    console.log(`🎵 Soundverse Enterprise API is LIVE!`);
    console.log(`📡 Server:    ${config.baseUrl}`);
    console.log(`📊 Dashboard: ${config.baseUrl}/`);
    console.log(`💚 Health:    ${config.baseUrl}/health`);
    console.log(`================================================================\n`);
  });

  const shutdown = () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});

