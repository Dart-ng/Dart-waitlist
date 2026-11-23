const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const WAITLIST_QUEUE_LOCK_ID = 707301;
const DATABASE_SCHEMA_LOCK_ID = 707302;

function toPostgresPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeRow(row) {
  if (!row) return row;
  if (row.expires_at !== undefined && row.expires_at !== null) {
    row.expires_at = Number(row.expires_at);
  }
  return row;
}

class AppDatabase {
  constructor({ databaseUrl, databasePath }) {
    this.isPostgres = Boolean(databaseUrl);
    this.sqlite = null;
    this.pool = null;

    if (this.isPostgres) {
      const connectionUrl = new URL(databaseUrl);
      if (!connectionUrl.searchParams.has('sslmode')) {
        connectionUrl.searchParams.set('sslmode', 'require');
      }
      const poolOptions = {
        connectionString: connectionUrl.toString(),
        connectionTimeoutMillis: 10000,
      };
      if (process.env.VERCEL === '1') {
        poolOptions.max = 1;
      }
      this.pool = new Pool(poolOptions);
      this.pool.on('error', (error) => {
        console.error('Unexpected PostgreSQL pool error:', error.name || 'Error');
      });
    } else {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const Database = require('better-sqlite3');
      this.sqlite = new Database(databasePath);
      this.sqlite.pragma('foreign_keys = ON');
    }
  }

  async initialize() {
    if (this.isPostgres) {
      const schema = fs.readFileSync(path.join(__dirname, 'migrations', '001_postgres.sql'), 'utf8');
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [DATABASE_SCHEMA_LOCK_ID]);
        await client.query(schema);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      await this.pool.query('SELECT 1');
      return;
    }

    const userColumns = this.sqlite.pragma('table_info(users)');
    if (!userColumns.length) {
      throw new Error('The users table is missing from the configured SQLite database.');
    }
    if (!userColumns.some((column) => column.name === 'google_sub')) {
      this.sqlite.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
    }
    if (!userColumns.some((column) => column.name === 'google_picture_url')) {
      this.sqlite.exec('ALTER TABLE users ADD COLUMN google_picture_url TEXT');
    }
    this.sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL');
  }

  async get(sql, parameters = [], client = null) {
    if (this.isPostgres) {
      const result = await (client || this.pool).query(toPostgresPlaceholders(sql), parameters);
      return normalizeRow(result.rows[0]);
    }
    return this.sqlite.prepare(sql).get(...parameters);
  }

  async all(sql, parameters = [], client = null) {
    if (this.isPostgres) {
      const result = await (client || this.pool).query(toPostgresPlaceholders(sql), parameters);
      return result.rows.map(normalizeRow);
    }
    return this.sqlite.prepare(sql).all(...parameters);
  }

  async run(sql, parameters = [], client = null) {
    if (this.isPostgres) {
      return (client || this.pool).query(toPostgresPlaceholders(sql), parameters);
    }
    return this.sqlite.prepare(sql).run(...parameters);
  }

  async nextQueueNumber(client = null) {
    if (this.isPostgres) {
      if (!client) {
        throw new Error('PostgreSQL queue positions must be allocated inside a transaction.');
      }
      await client.query('SELECT pg_advisory_xact_lock($1)', [WAITLIST_QUEUE_LOCK_ID]);
      const row = await this.get('SELECT COALESCE(MAX(queue_number), 0) + 1 AS next FROM users', [], client);
      return Number(row.next);
    }
    return this.sqlite.prepare('SELECT COALESCE(MAX(queue_number), 0) + 1 AS next FROM users').get().next;
  }

  async transaction(callback) {
    if (!this.isPostgres) {
      throw new Error('Asynchronous transactions are only available for PostgreSQL.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  sqliteTransaction(callback) {
    if (this.isPostgres) {
      throw new Error('Synchronous transactions are only available for SQLite.');
    }
    return this.sqlite.transaction(callback)();
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
    } else if (this.sqlite) {
      this.sqlite.close();
    }
  }
}

module.exports = { AppDatabase, toPostgresPlaceholders };
