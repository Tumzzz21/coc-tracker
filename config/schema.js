// Idempotent schema helpers shared by the startup migrations and the admin tools.
// Catalog lookups branch on the active driver: PostgreSQL reads information_schema,
// SQLite reads sqlite_master / pragma_table_info.
const pool = require('./db');

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSqlite() {
  return pool.driver === 'sqlite';
}

async function tableExists(table) {
  if (isSqlite()) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [table]
    );
    return rows[0].count > 0;
  }
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
  if (isSqlite()) {
    if (!identifierPattern.test(table)) throw new Error(`Unsafe table name: ${table}`);
    const [rows] = await pool.execute('SELECT name FROM pragma_table_info(?) WHERE name = ?', [table, column]);
    return rows.length > 0;
  }
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

// SQLite cannot ADD COLUMN with a CURRENT_TIMESTAMP default and does not know
// the PostgreSQL types, so migration definitions are translated on the fly.
function sqliteDefinition(definition) {
  return definition
    .replace(/\bTIMESTAMPTZ\b/gi, 'TEXT')
    .replace(/\bVARCHAR\(\d+\)/gi, 'TEXT')
    .replace(/\bBOOLEAN\b/gi, 'INTEGER')
    .replace(/NOT NULL DEFAULT CURRENT_TIMESTAMP/gi, "DEFAULT ''");
}

// The column is checked first so this migration also works against older
// PostgreSQL databases created before the column was introduced.
async function ensureColumn(table, column, definition) {
  if (await columnExists(table, column)) return false;
  if (isSqlite()) {
    if (!identifierPattern.test(table) || !identifierPattern.test(column)) {
      throw new Error('Table and column names must be plain identifiers.');
    }
    await pool.execute(
      `ALTER TABLE "${table}" ADD COLUMN "${column}" ${sqliteDefinition(definition)}`
    );
    return true;
  }
  await pool.execute(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  return true;
}

module.exports = { columnExists, ensureColumn, tableExists };
