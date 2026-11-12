import path from 'path';
import type { Knex } from 'knex';

const sqliteConfig: Knex.Config = {
  client: 'better-sqlite3',
  connection: {
    filename: process.env.SQLITE_PATH || path.join(__dirname, 'data', 'soundverse.db'),
  },
  useNullAsDefault: true,
  migrations: {
    directory: path.join(__dirname, 'src', 'db', 'migrations'),
    extension: 'ts',
  },
  seeds: {
    directory: path.join(__dirname, 'src', 'db', 'seeds'),
    extension: 'ts',
  },
  pool: {
    afterCreate: (conn: any, cb: Function) => {
      conn.pragma('journal_mode = WAL');
      conn.pragma('busy_timeout = 5000');
      conn.pragma('foreign_keys = ON');
      cb();
    },
  },
};

const config: Record<string, Knex.Config> = {
  development: sqliteConfig,
  test: {
    ...sqliteConfig,
    connection: {
      filename: ':memory:',
    },
  },
  production: process.env.DATABASE_URL
    ? {
        client: 'pg',
        connection: process.env.DATABASE_URL,
        migrations: sqliteConfig.migrations,
        seeds: sqliteConfig.seeds,
      }
    : sqliteConfig,
};

export default config;
module.exports = config;

