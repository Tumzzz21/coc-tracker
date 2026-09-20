'use strict';
// Embedded SQLite backend used when no PostgreSQL server is reachable.
// Node.js 22+ ships node:sqlite, so this adds no dependencies and lets the app
// run locally without installing or starting a database server. The schema
// mirrors schema.sql with SQLite types (INTEGER PRIMARY KEY rowids, TEXT
// timestamps) and keeps the same table and column names as PostgreSQL.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Columns the PostgreSQL driver returns as real booleans; SQLite stores 0/1,
// so they are converted back to keep API responses identical on both backends.
const booleanColumns = new Set(['isconfirmed', 'missedattack', 'selected']);

let database = null;

function resolveDatabaseFile() {
  if (process.env.SQLITE_PATH) return process.env.SQLITE_PATH;
  const directory = path.join(__dirname, '..', 'data');
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, 'coc-tracker.sqlite');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirmation_code VARCHAR(64),
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  player_tag VARCHAR(15) NOT NULL DEFAULT 'N/A',
  player_name VARCHAR(100) NOT NULL,
  town_hall_level SMALLINT NOT NULL CHECK (town_hall_level BETWEEN 1 AND 18),
  role VARCHAR(20) NOT NULL DEFAULT 'member'
    CHECK (role IN ('leader', 'co-leader', 'elder', 'member'))
);

CREATE TABLE IF NOT EXISTS war_logs (
  id INTEGER PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES members(id) ON UPDATE CASCADE ON DELETE CASCADE,
  war_date DATE NOT NULL,
  attacks_used SMALLINT NOT NULL DEFAULT 0 CHECK (attacks_used BETWEEN 0 AND 2),
  missed_attack BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (member_id, war_date)
);

CREATE TABLE IF NOT EXISTS capital_logs (
  id INTEGER PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES members(id) ON UPDATE CASCADE ON DELETE CASCADE,
  raid_weekend_date DATE NOT NULL,
  attacks_used SMALLINT NOT NULL DEFAULT 0 CHECK (attacks_used BETWEEN 0 AND 6),
  capital_gold_looted INTEGER NOT NULL DEFAULT 0 CHECK (capital_gold_looted >= 0),
  UNIQUE (member_id, raid_weekend_date)
);

CREATE TABLE IF NOT EXISTS settings (
  id BIGINT PRIMARY KEY,
  bg_image_url VARCHAR(2048)
);

INSERT INTO settings (id, bg_image_url)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS war_sessions (
  id INTEGER PRIMARY KEY,
  session_name VARCHAR(100) NOT NULL,
  session_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS capital_sessions (
  id INTEGER PRIMARY KEY,
  session_name VARCHAR(100) NOT NULL,
  session_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS war_attendance (
  session_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  selected BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(20) NOT NULL DEFAULT 'unmarked' CHECK (status IN ('present', 'absent', 'unmarked')),
  attacks_used SMALLINT NOT NULL DEFAULT 0 CHECK (attacks_used BETWEEN 0 AND 2),
  PRIMARY KEY (session_id, member_id),
  CONSTRAINT fk_war_attendance_session FOREIGN KEY (session_id) REFERENCES war_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_war_attendance_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS capital_attendance (
  session_id BIGINT NOT NULL,
  member_id BIGINT NOT NULL,
  selected BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(20) NOT NULL DEFAULT 'unmarked' CHECK (status IN ('present', 'absent', 'unmarked')),
  attacks_used SMALLINT NOT NULL DEFAULT 0 CHECK (attacks_used BETWEEN 0 AND 6),
  PRIMARY KEY (session_id, member_id),
  CONSTRAINT fk_capital_attendance_session FOREIGN KEY (session_id) REFERENCES capital_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_capital_attendance_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);
`;

function open() {
  if (database) return database;
  const file = resolveDatabaseFile();
  database = new DatabaseSync(file);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(SCHEMA);
  return database;
}

// Catalog queries can arrive while the PostgreSQL dialect is still selected
// (the fallback activates mid-query). Translate the ones the schema helpers
// use so the first request after a fallback does not fail.
function translateCatalogQuery(sql) {
  if (/information_schema\.tables/i.test(sql)) {
    return "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?";
  }
  if (/information_schema\.columns/i.test(sql)) {
    return 'SELECT COUNT(*) AS count FROM pragma_table_info(?) WHERE name = ?';
  }
  return sql;
}

function toSqliteValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function normalizeRow(row) {
  for (const key of Object.keys(row)) {
    if (booleanColumns.has(key.toLowerCase()) && (row[key] === 0 || row[key] === 1)) {
      row[key] = row[key] === 1;
    }
  }
  return row;
}

// Routes check Postgres-style error codes ('23505' unique, '42P01' missing
// table), so SQLite errors are re-tagged to keep that logic working.
function mapSqliteError(error) {
  const message = String(error && error.message || '');
  const code = String(error && error.code || '');
  if (/UNIQUE constraint failed/i.test(message)) {
    error.code = '23505';
  } else if (/FOREIGN KEY constraint failed/i.test(message)) {
    error.code = '23503';
  } else if (/no such table/i.test(message) || code === 'SQLITE_MISSING_TABLE') {
    error.code = '42P01';
  }
  return error;
}

async function execute(sql, params = []) {
  try {
    open();
    const bound = params.map(toSqliteValue);
    const statement = database.prepare(translateCatalogQuery(sql));
    // RETURNING statements produce rows, so node:sqlite requires all()/get().
    const returnsRows = /\bRETURNING\b/i.test(sql) || /^\s*(SELECT|WITH)\b/i.test(sql);
    if (returnsRows) {
      const rows = statement.all(...bound).map(normalizeRow);
      const insertId = rows.length && rows[0] && rows[0].id !== undefined ? Number(rows[0].id) : undefined;
      return [rows, { affectedRows: rows.length, insertId }];
    }
    const info = statement.run(...bound);
    return [{
      affectedRows: Number(info.changes),
      insertId: info.lastInsertRowid !== undefined ? Number(info.lastInsertRowid) : undefined
    }, []];
  } catch (error) {
    throw mapSqliteError(error);
  }
}

// One shared connection; SQLite calls are synchronous so no pooling is needed.
async function getConnection() {
  open();
  return {
    execute,
    beginTransaction: async () => database.exec('BEGIN'),
    commit: async () => database.exec('COMMIT'),
    rollback: async () => {
      try { database.exec('ROLLBACK'); } catch (error) { /* no open transaction */ }
    },
    release: () => {}
  };
}

async function end() {
  if (database) {
    database.close();
    database = null;
  }
}

module.exports = { execute, getConnection, end };