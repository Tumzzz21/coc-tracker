// Idempotent schema helpers shared by the startup migrations and the admin tools.
const pool = require('./db');

async function tableExists(table) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ?`,
    [table]
  );
  return rows[0].count > 0;
}

async function columnExists(table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ?
        AND column_name = ?`,
    [table, column]
  );
  return rows[0].count > 0;
}

// The column is checked first so this migration also works against older
// PostgreSQL databases created before the column was introduced.
async function ensureColumn(table, column, definition) {
  if (await columnExists(table, column)) return false;
  await pool.execute(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  return true;
}

module.exports = { columnExists, ensureColumn, tableExists };
