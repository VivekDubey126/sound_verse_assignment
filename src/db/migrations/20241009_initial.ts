import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── Plans (configurable without deploy) ──
  await knex.schema.createTable('plans', (t) => {
    t.string('name', 50).primary();
    t.string('display_name', 100).notNullable();
    t.integer('monthly_allowance').notNullable().defaultTo(0);
    t.integer('parallel_generations').notNullable().defaultTo(1);
    t.integer('requests_per_hour').notNullable().defaultTo(60);
    t.integer('requests_per_day').notNullable().defaultTo(500);
    t.text('licenses_available').notNullable().defaultTo('["royalty_free"]'); // JSON array
    t.string('beyond_allowance', 20).notNullable().defaultTo('none');
  });

  // ── Accounts ──
  await knex.schema.createTable('accounts', (t) => {
    t.string('id', 36).primary(); // UUID
    t.string('email', 255).unique().notNullable();
    t.string('password_hash', 255).notNullable();
    t.integer('email_verified').defaultTo(0); // boolean
    t.string('email_verification_token', 255).nullable();
    t.string('plan_name', 50).notNullable().defaultTo('sandbox')
      .references('name').inTable('plans');
    t.string('allowance_period_start', 30).nullable(); // ISO 8601
    t.string('created_at', 30).notNullable();
    t.string('updated_at', 30).notNullable();
  });

  // ── API Keys ──
  await knex.schema.createTable('api_keys', (t) => {
    t.string('id', 36).primary();
    t.string('account_id', 36).notNullable()
      .references('id').inTable('accounts').onDelete('CASCADE');
    t.string('key_prefix', 24).notNullable();
    t.string('key_hash', 64).notNullable(); // SHA-256 hex
    t.string('name', 100).nullable();
    t.string('mode', 10).notNullable(); // 'test' | 'live'
    t.text('scopes').notNullable().defaultTo('["generations:write","generations:read"]');
    t.integer('is_revoked').defaultTo(0);
    t.string('last_used_at', 30).nullable();
    t.string('created_at', 30).notNullable();
    t.index('key_hash');
    t.index('account_id');
  });

  // ── Generations ──
  await knex.schema.createTable('generations', (t) => {
    t.string('id', 20).primary(); // gen_xxxx
    t.string('account_id', 36).notNullable()
      .references('id').inTable('accounts');
    t.string('api_key_id', 36).notNullable()
      .references('id').inTable('api_keys');
    t.text('prompt').notNullable();
    t.integer('duration_sec').notNullable().defaultTo(30);
    t.string('license', 30).notNullable();
    t.integer('instrumental').defaultTo(1);
    t.text('metadata').defaultTo('{}'); // JSON
    t.string('status', 20).notNullable().defaultTo('queued');
    t.string('model', 100).nullable();
    t.integer('credits_charged').defaultTo(0);
    t.text('output_url').nullable();
    t.float('output_duration_sec').nullable();
    t.string('output_format', 10).defaultTo('mp3');
    t.text('error_message').nullable();
    t.string('idempotency_key', 255).nullable();
    t.string('created_at', 30).notNullable();
    t.string('started_at', 30).nullable();
    t.string('completed_at', 30).nullable();
    t.index(['account_id', 'status']);
    t.unique(['account_id', 'idempotency_key']);
  });

  // ── Usage Ledger (append-only) ──
  await knex.schema.createTable('usage_ledger', (t) => {
    t.string('id', 36).primary();
    t.string('account_id', 36).notNullable()
      .references('id').inTable('accounts');
    t.string('generation_id', 20).nullable()
      .references('id').inTable('generations');
    t.integer('credits').notNullable();
    t.string('license', 30).nullable();
    t.text('description').nullable();
    t.string('period_start', 30).notNullable();
    t.string('period_end', 30).notNullable();
    t.string('api_key_id', 36).nullable();
    t.string('created_at', 30).notNullable();
    t.index(['account_id', 'period_start', 'period_end']);
  });
  await knex.raw('CREATE VIEW IF NOT EXISTS ledger_entries AS SELECT * FROM usage_ledger');

  // ── Webhook Endpoints ──
  await knex.schema.createTable('webhook_endpoints', (t) => {
    t.string('id', 36).primary();
    t.string('account_id', 36).notNullable()
      .references('id').inTable('accounts').onDelete('CASCADE');
    t.text('url').notNullable();
    t.string('secret', 64).notNullable();
    t.text('events').notNullable().defaultTo('["generation.completed","generation.failed"]');
    t.integer('is_active').defaultTo(1);
    t.string('created_at', 30).notNullable();
    t.string('updated_at', 30).notNullable();
  });

  // ── Webhook Deliveries ──
  await knex.schema.createTable('webhook_deliveries', (t) => {
    t.string('id', 36).primary();
    t.string('webhook_endpoint_id', 36).notNullable()
      .references('id').inTable('webhook_endpoints').onDelete('CASCADE');
    t.string('generation_id', 20).nullable();
    t.string('event_type', 50).notNullable();
    t.text('payload').notNullable(); // JSON
    t.integer('response_status').nullable();
    t.text('response_body').nullable();
    t.integer('attempt').defaultTo(0);
    t.integer('max_attempts').defaultTo(5);
    t.string('next_retry_at', 30).nullable();
    t.string('delivered_at', 30).nullable();
    t.string('created_at', 30).notNullable();
  });

  // ── Audit Log ──
  await knex.schema.createTable('audit_log', (t) => {
    t.string('id', 36).primary();
    t.string('account_id', 36).notNullable()
      .references('id').inTable('accounts');
    t.string('actor_type', 20).notNullable().defaultTo('user');
    t.string('actor_id', 255).nullable();
    t.string('action', 50).notNullable();
    t.string('resource_type', 50).notNullable();
    t.string('resource_id', 255).nullable();
    t.text('details').defaultTo('{}');
    t.string('ip_address', 45).nullable();
    t.string('created_at', 30).notNullable();
    t.index(['account_id', 'created_at']);
  });

  // ── Idempotency Keys ──
  await knex.schema.createTable('idempotency_keys', (t) => {
    t.string('id', 36).primary();
    t.string('account_id', 36).notNullable()
      .references('id').inTable('accounts');
    t.string('idempotency_key', 255).notNullable();
    t.string('request_path', 255).notNullable();
    t.string('request_body_hash', 64).notNullable();
    t.integer('response_status').nullable();
    t.text('response_body').nullable(); // JSON
    t.string('generation_id', 20).nullable();
    t.integer('locked').defaultTo(0);
    t.string('created_at', 30).notNullable();
    t.string('expires_at', 30).notNullable();
    t.unique(['account_id', 'idempotency_key']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('idempotency_keys');
  await knex.schema.dropTableIfExists('audit_log');
  await knex.schema.dropTableIfExists('webhook_deliveries');
  await knex.schema.dropTableIfExists('webhook_endpoints');
  await knex.schema.dropTableIfExists('usage_ledger');
  await knex.schema.dropTableIfExists('generations');
  await knex.schema.dropTableIfExists('api_keys');
  await knex.schema.dropTableIfExists('accounts');
  await knex.schema.dropTableIfExists('plans');
}

