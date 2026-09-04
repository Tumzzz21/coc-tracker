const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('./auth');

const router = express.Router();
const roles = new Set(['leader', 'co-leader', 'elder', 'member']);
const tagPattern = /^#[A-Z0-9]{3,12}$/;

function validateMember(body, partial = false) {
  const values = {};
  if (!partial || body.playerTag !== undefined) {
    if (typeof body.playerTag !== 'string' || !tagPattern.test(body.playerTag.trim().toUpperCase())) {
      return { error: 'playerTag must look like #ABC123.' };
    }
    values.playerTag = body.playerTag.trim().toUpperCase();
  }
  if (!partial || body.playerName !== undefined) {
    if (typeof body.playerName !== 'string' || body.playerName.trim().length < 1 || body.playerName.trim().length > 100) {
      return { error: 'playerName must be 1-100 characters.' };
    }
    values.playerName = body.playerName.trim();
  }
  if (!partial || body.townHallLevel !== undefined) {
    const level = Number(body.townHallLevel);
    if (!Number.isInteger(level) || level < 1 || level > 18) {
      return { error: 'townHallLevel must be an integer from 1 to 18.' };
    }
    values.townHallLevel = level;
  }
  if (!partial || body.role !== undefined) {
    if (typeof body.role !== 'string' || !roles.has(body.role)) {
      return { error: 'role must be leader, co-leader, elder, or member.' };
    }
    values.role = body.role;
  }
  return { values };
}

router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, player_tag AS playerTag, player_name AS playerName,
              town_hall_level AS townHallLevel, role
       FROM members ORDER BY town_hall_level DESC, player_name ASC`
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  const result = validateMember(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  const { playerTag, playerName, townHallLevel, role } = result.values;
  try {
    const [insert] = await pool.execute(
      'INSERT INTO members (player_tag, player_name, town_hall_level, role) VALUES (?, ?, ?, ?)',
      [playerTag, playerName, townHallLevel, role]
    );
    res.status(201).json({ data: { id: insert.insertId, ...result.values } });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That player tag is already in the roster.' });
    }
    next(error);
  }
});

async function updateMember(req, res, next) {
  const result = validateMember(req.body || {}, true);
  if (result.error) return res.status(400).json({ error: result.error });
  const keys = Object.keys(result.values);
  if (!keys.length) return res.status(400).json({ error: 'At least one member field is required.' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Member id must be a positive integer.' });

  const columns = { playerTag: 'player_tag', playerName: 'player_name', townHallLevel: 'town_hall_level', role: 'role' };
  const assignments = keys.map((key) => `${columns[key]} = ?`).join(', ');
  try {
    const [update] = await pool.execute(
      `UPDATE members SET ${assignments} WHERE id = ?`,
      [...keys.map((key) => result.values[key]), id]
    );
    if (!update.affectedRows) return res.status(404).json({ error: 'Member not found.' });
    res.json({ data: { id, ...result.values } });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That player tag is already in the roster.' });
    }
    next(error);
  }
}

router.patch('/:id', updateMember);
router.put('/:id', updateMember);

router.delete('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Member id must be a positive integer.' });
  try {
    const [result] = await pool.execute('DELETE FROM members WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Member not found.' });
    res.json({ message: 'Member and related activity logs deleted.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
