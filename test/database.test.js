const assert = require('node:assert/strict');
const test = require('node:test');
const { AppDatabase, toPostgresPlaceholders } = require('../database');

test('PostgreSQL placeholders are numbered in query order', () => {
  assert.equal(
    toPostgresPlaceholders('SELECT * FROM users WHERE email = ? AND queue_number < ?'),
    'SELECT * FROM users WHERE email = $1 AND queue_number < $2',
  );
});

test('SQLite fallback initializes the existing schema and assigns the next queue number', async (t) => {
  const database = new AppDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  database.sqlite.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, queue_number INTEGER, google_sub TEXT, google_picture_url TEXT)');

  await database.initialize();
  await database.run('INSERT INTO users (id, queue_number) VALUES (?, ?)', [1, 1]);

  assert.equal(await database.nextQueueNumber(), 2);
});

test('PostgreSQL queue allocation takes a transaction lock before reading the maximum', async (t) => {
  const database = new AppDatabase({
    databaseUrl: 'postgres://test:test@127.0.0.1:1/test',
    databasePath: ':memory:',
  });
  t.after(() => database.close());
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      return { rows: [{ next: '12' }] };
    },
  };

  assert.equal(await database.nextQueueNumber(client), 12);
  assert.match(statements[0], /pg_advisory_xact_lock/);
  assert.match(statements[1], /MAX\(queue_number\)/);
});
