const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

let db = null;

function getDb() {
  if (!db) {
    initDb();
  }
  return db;
}

function initDb(overridePath) {
  const dbPath = overridePath || process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'soundverse.db');
  
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new DatabaseSync(dbPath);

  // WAL mode for concurrency
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  runMigrations(db);
  seedPlans(db);

  return db;
}

function runMigrations(db) {
  // Plans table
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      name TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      monthly_allowance INTEGER NOT NULL DEFAULT 0,
      parallel_generations INTEGER NOT NULL DEFAULT 1,
      requests_per_hour INTEGER NOT NULL DEFAULT 60,
      requests_per_day INTEGER NOT NULL DEFAULT 500,
      licenses_available TEXT NOT NULL DEFAULT '["royalty_free"]',
      beyond_allowance TEXT NOT NULL DEFAULT 'none'
    );
  `);

  // Accounts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER DEFAULT 0,
      email_verification_token TEXT,
      plan_name TEXT NOT NULL DEFAULT 'sandbox',
      allowance_period_start TEXT,
      auth_provider TEXT DEFAULT 'email',
      google_id TEXT,
      display_name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  try {
    const accountCols = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
    if (!accountCols.includes('auth_provider')) {
      db.exec("ALTER TABLE accounts ADD COLUMN auth_provider TEXT DEFAULT 'email';");
    }
    if (!accountCols.includes('google_id')) {
      db.exec("ALTER TABLE accounts ADD COLUMN google_id TEXT;");
    }
    if (!accountCols.includes('display_name')) {
      db.exec("ALTER TABLE accounts ADD COLUMN display_name TEXT;");
    }
    if (!accountCols.includes('avatar_url')) {
      db.exec("ALTER TABLE accounts ADD COLUMN avatar_url TEXT;");
    }
  } catch (e) {
    // Ignore if already present
  }

  // API Keys table
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      name TEXT,
      mode TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '["generations:write","generations:read"]',
      is_revoked INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Generations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      api_key_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 30,
      license TEXT NOT NULL,
      instrumental INTEGER DEFAULT 1,
      metadata TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      model TEXT,
      credits_charged INTEGER DEFAULT 0,
      output_url TEXT,
      output_duration_sec REAL,
      output_format TEXT DEFAULT 'mp3',
      error_message TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
  `);

  // Usage ledger table (append-only)
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      generation_id TEXT,
      credits INTEGER NOT NULL,
      license TEXT,
      description TEXT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      api_key_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE VIEW IF NOT EXISTS ledger_entries AS SELECT * FROM usage_ledger;
  `);

  // Webhook endpoints
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '["generation.completed","generation.failed"]',
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Webhook deliveries
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_endpoint_id TEXT NOT NULL,
      generation_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      attempt INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 5,
      next_retry_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Audit log
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'user',
      actor_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT DEFAULT '{}',
      ip_address TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Idempotency keys
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_path TEXT NOT NULL,
      request_body_hash TEXT NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      generation_id TEXT,
      locked INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  // Users table (Identity)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER DEFAULT 0,
      email_verification_token TEXT,
      auth_provider TEXT DEFAULT 'email',
      google_id TEXT,
      display_name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Memberships table: links user/email to accounts with role & status
  db.exec(`
    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      user_id TEXT,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      status TEXT NOT NULL DEFAULT 'active', -- 'pending' | 'active'
      invited_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, email)
    );
  `);

  // Migrate existing data into users and memberships if needed
  try {
    const existingAccounts = db.prepare('SELECT * FROM accounts').all();
    for (const acc of existingAccounts) {
      if (acc.email) {
        db.prepare(`
          INSERT OR IGNORE INTO users (id, email, password_hash, email_verified, email_verification_token, auth_provider, google_id, display_name, avatar_url, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          acc.id,
          acc.email.toLowerCase(),
          acc.password_hash || 'OAUTH_GOOGLE',
          acc.email_verified || 1,
          acc.email_verification_token || null,
          acc.auth_provider || 'email',
          acc.google_id || null,
          acc.display_name || null,
          acc.avatar_url || null,
          acc.created_at,
          acc.updated_at
        );

        // Ensure owner membership exists
        db.prepare(`
          INSERT OR IGNORE INTO memberships (id, account_id, user_id, email, role, status, invited_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?)
        `).run(
          `mem_${acc.id}`,
          acc.id,
          acc.id,
          acc.email.toLowerCase(),
          acc.id,
          acc.created_at,
          acc.updated_at
        );
      }
    }

    // Migrate any legacy team_members into memberships
    const legacyMembers = db.prepare('SELECT * FROM team_members').all();
    for (const tm of legacyMembers) {
      const u = db.prepare('SELECT id FROM users WHERE email = ?').get(tm.email.toLowerCase());
      db.prepare(`
        INSERT OR IGNORE INTO memberships (id, account_id, user_id, email, role, status, invited_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        tm.id,
        tm.account_id,
        u ? u.id : null,
        tm.email.toLowerCase(),
        tm.role || 'viewer',
        tm.account_id,
        tm.created_at,
        tm.created_at
      );
    }
  } catch (mErr) {
    // Migration helper silent catch
  }

  // Team members backward compatibility table
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL
    );
  `);
}

function seedPlans(db) {
  const insertPlan = db.prepare(`
    INSERT OR REPLACE INTO plans (name, display_name, monthly_allowance, parallel_generations, requests_per_hour, requests_per_day, licenses_available, beyond_allowance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertPlan.run('sandbox', 'Sandbox', 0, 1, 60, 500, JSON.stringify(['royalty_free']), 'none');
  insertPlan.run('starter', 'Starter', 200, 3, 300, 3000, JSON.stringify(['royalty_free', 'sync']), 'hard_stop');
  insertPlan.run('growth', 'Growth', 2000, 10, 2000, 30000, JSON.stringify(['royalty_free', 'sync', 'full_ownership']), 'overage');
}

module.exports = { getDb, initDb };

