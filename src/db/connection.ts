import knex, { Knex } from 'knex';
import path from 'path';

let db: Knex;

export function getDb(): Knex {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export async function initDb(overridePath?: string): Promise<Knex> {
  const env = process.env.NODE_ENV || 'development';

  if (env === 'test') {
    db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: {
        afterCreate: (conn: any, cb: Function) => {
          conn.pragma('journal_mode = WAL');
          conn.pragma('foreign_keys = ON');
          cb();
        },
      },
      migrations: {
        directory: path.join(__dirname, 'migrations'),
        extension: 'ts',
      },
      seeds: {
        directory: path.join(__dirname, 'seeds'),
        extension: 'ts',
      },
    });
  } else {
    const filename = overridePath ||
      process.env.SQLITE_PATH ||
      path.join(process.cwd(), 'data', 'soundverse.db');

    db = knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: {
        afterCreate: (conn: any, cb: Function) => {
          conn.pragma('journal_mode = WAL');
          conn.pragma('busy_timeout = 5000');
          conn.pragma('foreign_keys = ON');
          cb();
        },
      },
      migrations: {
        directory: path.join(__dirname, 'migrations'),
        extension: 'ts',
      },
      seeds: {
        directory: path.join(__dirname, 'seeds'),
        extension: 'ts',
      },
    });
  }

  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
  }
}

