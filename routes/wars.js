const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('./auth');

const router = express.Router();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function dateValue(value, fieldName) {
  if (typeof value !== 'string' || !datePattern.test(value)) {
    return `${fieldName} must be YYYY-MM-DD.`;
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return `${fieldName} must be a real calendar date.`;
  }
  return null;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function boolValue(value) {
  return value === true || value === false ? value : null;
}

router.use(requireAuth);

router.get('/wars', async (req, res, next) => {
  const date = req.query.date;
  if (date !== undefined) {
    const error = dateValue(date, 'date');
    if (error) return res.status(400).json({ error });
  }
  try {
    const params = [];
    let where = '';
    if (date) {
      where = 'WHERE w.war_date = ?';
      params.push(date);
    }
    const [rows] = await pool.execute(
      `SELECT w.id, w.member_id AS memberId, m.player_name AS playerName,
              m.player_tag AS playerTag, w.war_date AS warDate,
              w.attacks_used AS attacksUsed, w.missed_attack AS missedAttack
       FROM war_logs w JOIN members m ON m.id = w.member_id
       ${where} ORDER BY w.war_date DESC, m.player_name ASC`,
      params
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/wars', async (req, res, next) => {
  const body = req.body || {};
  const memberId = positiveId(body.memberId);
  const dateError = dateValue(body.warDate, 'warDate');
  const attacksUsed = Number(body.attacksUsed);
  const missedAttack = boolValue(body.missedAttack);
  if (!memberId || dateError || !Number.isInteger(attacksUsed) || attacksUsed < 0 || attacksUsed > 2 || missedAttack === null) {
    return res.status(400).json({
      error: dateError || 'memberId, attacksUsed (0-2), and boolean missedAttack are required.'
    });
  }
  try {
    const [member] = await pool.execute('SELECT id FROM members WHERE id = ?', [memberId]);
    if (!member.length) return res.status(404).json({ error: 'Member not found.' });
    await pool.execute(
      `INSERT INTO war_logs (member_id, war_date, attacks_used, missed_attack)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE attacks_used = VALUES(attacks_used),
         missed_attack = VALUES(missed_attack)`,
      [memberId, body.warDate, attacksUsed, missedAttack]
    );
    res.status(201).json({ data: { memberId, warDate: body.warDate, attacksUsed, missedAttack } });
  } catch (error) {
    next(error);
  }
});

router.delete('/wars/:id', async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'War log id must be a positive integer.' });
  try {
    const [result] = await pool.execute('DELETE FROM war_logs WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'War log not found.' });
    res.json({ message: 'War log deleted.' });
  } catch (error) {
    next(error);
  }
});

router.get('/capital', async (req, res, next) => {
  const date = req.query.date;
  if (date !== undefined) {
    const error = dateValue(date, 'date');
    if (error) return res.status(400).json({ error });
  }
  try {
    const params = [];
    let where = '';
    if (date) {
      where = 'WHERE c.raid_weekend_date = ?';
      params.push(date);
    }
    const [rows] = await pool.execute(
      `SELECT c.id, c.member_id AS memberId, m.player_name AS playerName,
              m.player_tag AS playerTag, c.raid_weekend_date AS raidWeekendDate,
              c.attacks_used AS attacksUsed, c.capital_gold_looted AS capitalGoldLooted
       FROM capital_logs c JOIN members m ON m.id = c.member_id
       ${where} ORDER BY c.raid_weekend_date DESC, m.player_name ASC`,
      params
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

router.post('/capital', async (req, res, next) => {
  const body = req.body || {};
  const memberId = positiveId(body.memberId);
  const dateError = dateValue(body.raidWeekendDate, 'raidWeekendDate');
  const attacksUsed = Number(body.attacksUsed);
  const capitalGoldLooted = Number(body.capitalGoldLooted);
  if (
    !memberId || dateError || !Number.isInteger(attacksUsed) || attacksUsed < 0 || attacksUsed > 6 ||
    !Number.isInteger(capitalGoldLooted) || capitalGoldLooted < 0 || capitalGoldLooted > 2147483647
  ) {
    return res.status(400).json({
      error: dateError || 'memberId, attacksUsed (0-6), and capitalGoldLooted (0 or more) are required.'
    });
  }
  try {
    const [member] = await pool.execute('SELECT id FROM members WHERE id = ?', [memberId]);
    if (!member.length) return res.status(404).json({ error: 'Member not found.' });
    await pool.execute(
      `INSERT INTO capital_logs (member_id, raid_weekend_date, attacks_used, capital_gold_looted)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE attacks_used = VALUES(attacks_used),
         capital_gold_looted = VALUES(capital_gold_looted)`,
      [memberId, body.raidWeekendDate, attacksUsed, capitalGoldLooted]
    );
    res.status(201).json({ data: { memberId, raidWeekendDate: body.raidWeekendDate, attacksUsed, capitalGoldLooted } });
  } catch (error) {
    next(error);
  }
});

router.delete('/capital/:id', async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Capital log id must be a positive integer.' });
  try {
    const [result] = await pool.execute('DELETE FROM capital_logs WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Capital log not found.' });
    res.json({ message: 'Capital log deleted.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
