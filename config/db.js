// PostgreSQL connection shared by local Node.js and Vercel runtimes.
require('dotenv').config();

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
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

function postgresQuery(sql, params) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function execute(sql, params = []) {
  const result = await pool.query(postgresQuery(sql, params), params);
  const rows = result.rows;
  const metadata = {
    affectedRows: result.rowCount,
    insertId: rows[0] && rows[0].id ? Number(rows[0].id) : undefined
  };
  return /^\s*(SELECT|WITH)\b/i.test(sql) ? [rows, metadata] : [metadata, rows];
}

async function getConnection() {
  const client = await pool.connect();
  return {
    execute: (sql, params) => executeWithClient(client, sql, params),
    beginTransaction: () => client.query('BEGIN'),
    commit: () => client.query('COMMIT'),
    rollback: () => client.query('ROLLBACK'),
    release: () => client.release()
  };
}

async function executeWithClient(client, sql, params = []) {
  const result = await client.query(postgresQuery(sql, params), params);
  const metadata = {
    affectedRows: result.rowCount,
    insertId: result.rows[0] && result.rows[0].id ? Number(result.rows[0].id) : undefined
  };
  return /^\s*(SELECT|WITH)\b/i.test(sql) ? [result.rows, metadata] : [metadata, result.rows];
}

module.exports = { execute, getConnection, query: (sql, params) => pool.query(postgresQuery(sql, params), params), end: () => pool.end() };
