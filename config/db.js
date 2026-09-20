// PostgreSQL connection shared by local Node.js and Vercel runtimes.
//
// If no PostgreSQL server can be reached (typical on machines without a local
// install), the module transparently falls back to an embedded SQLite database
// so the app still runs. The fallback is disabled on Vercel, where a missing
// DATABASE_URL must surface instead of silently writing throwaway data.
require('dotenv').config();

const { Pool } = require('pg');
const sqliteBackend = require('./sqlite-backend');

const connectionString = process.env.DATABASE_URL
  || process.env.POSTGRES_PRISMA_URL
  || process.env.POSTGRES_URL
  || process.env.POSTGRES_URL_NON_POOLING;
const postgresConfigured = Boolean(connectionString || process.env.DB_USER || process.env.DB_NAME);
const preferSqlite = String(process.env.DB_CLIENT || '').trim().toLowerCase() === 'sqlite';
const onServerless = Boolean(process.env.VERCEL);

const pool = new Pool({
  ...(connectionString ? { connectionString } : {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  }),
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.DB_SSL === 'false' ? false : (connectionString ? { rejectUnauthorized: false } : false)
});

let usingSqlite = preferSqlite || !postgresConfigured;

// Connection-class failures trigger the SQLite fallback; anything else (bad
// SQL, constraint violations) is a real bug and must surface.
const connectionFailureCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  '28P01', '3D000', '08001', '08006'
]);

function activateSqliteFallback(reason) {
  if (usingSqlite) return; // notice only once even if several queries race
  usingSqlite = true;
  console.warn('='.repeat(72));
  console.warn('PostgreSQL is not reachable, switching to the embedded SQLite fallback.');
  console.warn(`Reason: ${reason && reason.code ? `${reason.code} ` : ''}${reason && reason.message}`);
  console.warn('Data is saved locally in data/coc-tracker.sqlite. To use PostgreSQL,');
  console.warn('set DATABASE_URL (e.g. Supabase) in .env and restart the server.');
  console.warn('='.repeat(72));
}

function canFallBack(error) {
  if (usingSqlite || preferSqlite || onServerless) return false;
  return connectionFailureCodes.has(String(error && error.code));
}

function postgresQuery(sql, params) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function formatPostgresResult(sql, result) {
  const rows = result.rows;
  const metadata = {
    affectedRows: result.rowCount,
    insertId: rows[0] && rows[0].id ? Number(rows[0].id) : undefined
  };
  return /^\s*(SELECT|WITH)\b/i.test(sql) ? [rows, metadata] : [metadata, rows];
}

async function executePostgres(sql, params) {
  const result = await pool.query(postgresQuery(sql, params), params);
  return formatPostgresResult(sql, result);
}

async function execute(sql, params = []) {
  if (!usingSqlite) {
    try {
      return await executePostgres(sql, params);
    } catch (error) {
      if (!canFallBack(error)) throw error;
      activateSqliteFallback(error);
    }
  }
  return sqliteBackend.execute(sql, params);
}

async function executeWithClient(client, sql, params = []) {
  const result = await client.query(postgresQuery(sql, params), params);
  return formatPostgresResult(sql, result);
}

async function getConnection() {
  if (usingSqlite) return sqliteBackend.getConnection();
  try {
    const client = await pool.connect();
    return {
      execute: (sql, params) => executeWithClient(client, sql, params),
      beginTransaction: () => client.query('BEGIN'),
      commit: () => client.query('COMMIT'),
      rollback: () => client.query('ROLLBACK'),
      release: () => client.release()
    };
  } catch (error) {
    if (!canFallBack(error)) throw error;
    activateSqliteFallback(error);
    return sqliteBackend.getConnection();
  }
}

module.exports = {
  execute,
  getConnection,
  query: async (sql, params) => {
    if (usingSqlite) {
      const [rows, metadata] = await sqliteBackend.execute(sql, params);
      return { rows, rowCount: metadata.affectedRows };
    }
    return pool.query(postgresQuery(sql, params), params);
  },
  end: async () => {
    await sqliteBackend.end();
    try { await pool.end(); } catch (error) { /* pool may already be closed */ }
  },
  get driver() {
    return usingSqlite ? 'sqlite' : 'postgres';
  }
};
