// Idempotent schema helpers shared by the startup migrations and the admin tools.
const pool = require('./db');

async function tableExists(table) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = ?`,
    [table]
  );
  return rows[0].count > 0;
}

async function columnExists(table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?`,
    [table, column]
  );
  return rows[0].count > 0;
}

// MySQL 8 has no "ADD COLUMN IF NOT EXISTS" clause (that is MariaDB syntax), so the
// column is checked first and a plain ALTER TABLE runs only when it is missing.
async function ensureColumn(table, column, definition) {
  if (await columnExists(table, column)) return false;
  await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  return true;
}

module.exports = { columnExists, ensureColumn, tableExists };
