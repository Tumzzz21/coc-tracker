const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('./auth');

const router = express.Router();
const config = {
  war: { sessions: 'war_sessions', attendance: 'war_attendance', maxAttacks: 2 },
  capital: { sessions: 'capital_sessions', attendance: 'capital_attendance', maxAttacks: 6 }
};
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

let tablesReady;

async function initializeTables() {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS war_sessions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      session_name VARCHAR(100) NOT NULL,
      session_date DATE NOT NULL,
      status ENUM('active', 'finished') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB`
  );
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS capital_sessions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      session_name VARCHAR(100) NOT NULL,
      session_date DATE NOT NULL,
      status ENUM('active', 'finished') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB`
  );
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS war_attendance (
      session_id INT UNSIGNED NOT NULL,
      member_id INT UNSIGNED NOT NULL,
      selected BOOLEAN NOT NULL DEFAULT TRUE,
      status ENUM('present', 'absent', 'unmarked') NOT NULL DEFAULT 'unmarked',
      attacks_used TINYINT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, member_id),
      CONSTRAINT fk_war_attendance_session FOREIGN KEY (session_id) REFERENCES war_sessions(id) ON DELETE CASCADE,
      CONSTRAINT fk_war_attendance_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
      CONSTRAINT chk_war_attendance_attacks CHECK (attacks_used BETWEEN 0 AND 2)
    ) ENGINE=InnoDB`
  );
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS capital_attendance (
      session_id INT UNSIGNED NOT NULL,
      member_id INT UNSIGNED NOT NULL,
      selected BOOLEAN NOT NULL DEFAULT TRUE,
      status ENUM('present', 'absent', 'unmarked') NOT NULL DEFAULT 'unmarked',
      attacks_used TINYINT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, member_id),
      CONSTRAINT fk_capital_attendance_session FOREIGN KEY (session_id) REFERENCES capital_sessions(id) ON DELETE CASCADE,
      CONSTRAINT fk_capital_attendance_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
      CONSTRAINT chk_capital_attendance_attacks CHECK (attacks_used BETWEEN 0 AND 6)
    ) ENGINE=InnoDB`
  );
  await pool.execute(
    `ALTER TABLE war_attendance
     ADD COLUMN IF NOT EXISTS selected BOOLEAN NOT NULL DEFAULT TRUE,
     ADD COLUMN IF NOT EXISTS status ENUM('present', 'absent', 'unmarked') NOT NULL DEFAULT 'unmarked',
     ADD COLUMN IF NOT EXISTS attacks_used TINYINT UNSIGNED NOT NULL DEFAULT 0`
  );
  await pool.execute(
    `ALTER TABLE war_sessions
     ADD COLUMN IF NOT EXISTS status ENUM('active', 'finished') NOT NULL DEFAULT 'active',
     ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
  );
  await pool.execute(
    `ALTER TABLE capital_sessions
     ADD COLUMN IF NOT EXISTS status ENUM('active', 'finished') NOT NULL DEFAULT 'active',
     ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
  );
  await pool.execute(
    `ALTER TABLE capital_attendance
     ADD COLUMN IF NOT EXISTS selected BOOLEAN NOT NULL DEFAULT TRUE,
     ADD COLUMN IF NOT EXISTS status ENUM('present', 'absent', 'unmarked') NOT NULL DEFAULT 'unmarked',
     ADD COLUMN IF NOT EXISTS attacks_used TINYINT UNSIGNED NOT NULL DEFAULT 0`
  );
}

async function ensureTables(req, res, next) {
  try {
    await initializeSessionTables();
    next();
  } catch (error) {
    error.statusCode = 503;
    error.publicMessage = 'Session storage is not initialized. Run schema.sql or restart the server to initialize it.';
    next(error);
  }
}

function initializeSessionTables() {
  if (!tablesReady) {
    tablesReady = initializeTables().catch((error) => {
      tablesReady = null;
      throw error;
    });
  }
  return tablesReady;
}

function getConfig(type) {
  return config[type] || null;
}

function validateSession(body) {
  if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
    return 'Session name is required and must be 100 characters or fewer.';
  }
  if (typeof body.date !== 'string' || !datePattern.test(body.date)) {
    return 'Session date must be YYYY-MM-DD.';
  }
  return null;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.use(requireAuth);
router.use(ensureTables);

router.get('/:type', async (req, res, next) => {
  const selected = getConfig(req.params.type);
  if (!selected) return res.status(404).json({ error: 'Unknown session type.' });
  try {
    const [rows] = await pool.execute(
      `SELECT id, session_name AS name, session_date AS date, status, created_at AS createdAt
       FROM ${selected.sessions} ORDER BY session_date DESC, id DESC`
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/:type', async (req, res, next) => {
  const selected = getConfig(req.params.type);
  if (!selected) return res.status(404).json({ error: 'Unknown session type.' });
  const validationError = validateSession(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  try {
    const [result] = await pool.execute(
      `INSERT INTO ${selected.sessions} (session_name, session_date) VALUES (?, ?)`,
      [req.body.name.trim(), req.body.date]
    );
    res.status(201).json({ data: { id: result.insertId, name: req.body.name.trim(), date: req.body.date, status: 'active' } });
  } catch (error) {
    next(error);
  }
});

router.get('/:type/:id', async (req, res, next) => {
  const selected = getConfig(req.params.type);
  const id = positiveId(req.params.id);
  if (!selected) return res.status(404).json({ error: 'Unknown session type.' });
  if (!id) return res.status(400).json({ error: 'Session id must be positive.' });
  try {
    const [sessions] = await pool.execute(`SELECT id, session_name AS name, session_date AS date, status FROM ${selected.sessions} WHERE id = ?`, [id]);
    if (!sessions.length) return res.status(404).json({ error: 'Session not found.' });
    const [attendance] = await pool.execute(
      `SELECT member_id AS memberId, selected, status, attacks_used AS attacksUsed FROM ${selected.attendance} WHERE session_id = ?`,
      [id]
    );
    res.json({ data: { ...sessions[0], attendance } });
  } catch (error) {
    next(error);
  }
});

router.put('/:type/:id/attendance', async (req, res, next) => {
  const selected = getConfig(req.params.type);
  const id = positiveId(req.params.id);
  if (!selected) return res.status(404).json({ error: 'Unknown session type.' });
  if (!id) return res.status(400).json({ error: 'Session id must be positive.' });
  const entries = Array.isArray(req.body && req.body.attendance) ? req.body.attendance : [];
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [sessionRows] = await connection.execute(`SELECT id FROM ${selected.sessions} WHERE id = ?`, [id]);
    if (!sessionRows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Session not found.' });
    }
    for (const entry of entries) {
      const memberId = positiveId(entry.memberId);
      const attacksUsed = Number(entry.attacksUsed);
      const status = entry.status || 'unmarked';
      const isSelected = entry.selected !== false;
      if (!memberId || !Number.isInteger(attacksUsed) || attacksUsed < 0 || attacksUsed > selected.maxAttacks || !['present', 'absent', 'unmarked'].includes(status)) {
        await connection.rollback();
        return res.status(400).json({ error: `Attendance values are invalid; attacks must be 0-${selected.maxAttacks}.` });
      }
      await connection.execute(
        `INSERT INTO ${selected.attendance} (session_id, member_id, selected, status, attacks_used)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE selected = VALUES(selected), status = VALUES(status), attacks_used = VALUES(attacks_used)`,
        [id, memberId, isSelected, status, attacksUsed]
      );
    }
    await connection.commit();
    res.json({ data: entries });
  } catch (error) {
    if (connection) await connection.rollback();
    next(error);
  } finally {
    if (connection) connection.release();
  }
});

router.post('/:type/:id/finish', async (req, res, next) => {
  const selected = getConfig(req.params.type);
  const id = positiveId(req.params.id);
  if (!selected) return res.status(404).json({ error: 'Unknown session type.' });
  if (!id) return res.status(400).json({ error: 'Session id must be positive.' });
  try {
    const [result] = await pool.execute(`UPDATE ${selected.sessions} SET status = 'finished' WHERE id = ?`, [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Session not found.' });
    res.json({ message: 'Session finished.' });
  } catch (error) {
    next(error);
  }
});

router.delete('/:type/:id', async (req, res, next) => {
  const selected = getConfig(req.params.type);
  const id = positiveId(req.params.id);
  if (!selected) return res.status(404).json({ error: 'Unknown session type.' });
  if (!id) return res.status(400).json({ error: 'Session id must be positive.' });
  try {
    const [result] = await pool.execute(`DELETE FROM ${selected.sessions} WHERE id = ?`, [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Session not found.' });
    res.json({ message: 'Session deleted.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.initializeSessionTables = initializeSessionTables;
