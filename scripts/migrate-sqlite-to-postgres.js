const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sourcePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'dart.sqlite'));
const databaseUrl = (process.env.DATABASE_URL || '').trim();

async function migrate() {
  if (!process.argv.includes('--confirm')) {
    throw new Error('Migration is disabled by default; rerun with --confirm after setting DATABASE_URL.');
  }
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must point to the empty PostgreSQL database.');
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error('The SQLite source database does not exist at DATABASE_PATH.');
  }

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_postgres.sql'), 'utf8');
    await pool.query(schema);

    const target = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM oauth_states) AS oauth_states,
        (SELECT COUNT(*) FROM announcements) AS announcements
    `);
    if (Object.values(target.rows[0]).some((count) => Number(count) !== 0)) {
      throw new Error('The PostgreSQL target must be empty before migration.');
    }

    source.exec('BEGIN');
    const users = source.prepare(`
      SELECT id, name, email, password_hash, password_salt, interest, queue_number,
             referral_code, referred_by, referral_count, ip_hash, role, created_at,
             google_sub, google_picture_url
      FROM users
      ORDER BY id
    `).all();
    const sessions = source.prepare('SELECT token_hash, user_id, expires_at FROM sessions').all();
    const oauthStates = source.prepare('SELECT state_hash, referral_code, expires_at FROM oauth_states').all();
    const announcements = source.prepare('SELECT id, message, created_at FROM announcements ORDER BY id').all();
    source.exec('COMMIT');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const user of users) {
        await client.query(`
          INSERT INTO users (
            id, name, email, password_hash, password_salt, interest, queue_number,
            referral_code, referred_by, referral_count, ip_hash, role, created_at,
            google_sub, google_picture_url
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
          )
        `, [
          user.id,
          user.name,
          user.email,
          user.password_hash,
          user.password_salt,
          user.interest,
          user.queue_number,
          user.referral_code,
          user.referred_by,
          user.referral_count,
          user.ip_hash,
          user.role,
          user.created_at,
          user.google_sub,
          user.google_picture_url,
        ]);
      }

      for (const session of sessions) {
        await client.query(
          'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
          [session.token_hash, session.user_id, session.expires_at],
        );
      }
      for (const state of oauthStates) {
        await client.query(
          'INSERT INTO oauth_states (state_hash, referral_code, expires_at) VALUES ($1, $2, $3)',
          [state.state_hash, state.referral_code, state.expires_at],
        );
      }
      for (const announcement of announcements) {
        await client.query(
          'INSERT INTO announcements (id, message, created_at) VALUES ($1, $2, $3)',
          [announcement.id, announcement.message, announcement.created_at],
        );
      }

      await client.query(`
        SELECT setval(
          pg_get_serial_sequence('users', 'id'),
          GREATEST(COALESCE((SELECT MAX(id) FROM users), 0), 1),
          EXISTS (SELECT 1 FROM users)
        )
      `);
      await client.query(`
        SELECT setval(
          pg_get_serial_sequence('announcements', 'id'),
          GREATEST(COALESCE((SELECT MAX(id) FROM announcements), 0), 1),
          EXISTS (SELECT 1 FROM announcements)
        )
      `);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    console.log(`Migrated ${users.length} users, ${sessions.length} sessions, ${oauthStates.length} OAuth states, and ${announcements.length} announcements.`);
  } finally {
    source.close();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('SQLite-to-PostgreSQL migration failed:', error.message || error.name || 'Error');
  process.exitCode = 1;
});
