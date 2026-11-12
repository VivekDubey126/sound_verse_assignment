import fs from 'fs';
import path from 'path';
import { createApp } from './app';
import { initDb } from './db/connection';
import { startWorker } from './services/worker';
import { config } from './config';

async function main() {
  console.log('🚀 Initializing Soundverse Enterprise API Platform...');

  // Ensure directories exist
  const dataDir = path.dirname(config.sqlitePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(config.storageDir)) {
    fs.mkdirSync(config.storageDir, { recursive: true });
  }

  // Initialize DB and run migrations + seed
  const db = await initDb();
  console.log('📦 Running database migrations...');
  await db.migrate.latest();
  console.log('🌱 Seeding initial plans...');
  await db.seed.run();

  // Start background queue worker
  startWorker();

  // Start Express server
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`\n================================================================`);
    console.log(`🎵 Soundverse Enterprise API is running!`);
    console.log(`📡 URL:       ${config.baseUrl}`);
    console.log(`📊 Dashboard: ${config.baseUrl}/`);
    console.log(`📖 Health:    ${config.baseUrl}/health`);
    console.log(`================================================================\n`);
  });

  const shutdown = async () => {
    console.log('\n🛑 Graceful shutdown initiated...');
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

