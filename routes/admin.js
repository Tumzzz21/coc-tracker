// Administrator-only account management. Every route here runs behind
// requireAuth + requireAdmin, so the role check happens server-side.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const roles = new Set(['admin', 'user']);

function emailValue(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return emailPattern.test(email) && email.length <= 255 ? email : null;
}

function passwordValue(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 ? value : null;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function adminCount() {
  const [rows] = await pool.execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
  return rows[0].count;
}

router.use(requireAuth, requireAdmin);

router.get('/users', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, email, role, is_confirmed AS isConfirmed, created_at AS createdAt
         FROM users ORDER BY role ASC, email ASC`
    );
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
});

// Admins provision accounts, which is why public self-registration can stay closed.
router.post('/users', async (req, res, next) => {
  const email = emailValue(req.body && req.body.email);
  const password = passwordValue(req.body && req.body.password);
  // Only the two known roles are accepted, so a crafted body cannot invent one.
  const requested = req.body && req.body.role;
  const role = roles.has(requested) ? requested : 'user';
  if (!email || !password) {
    return res.status(400).json({ error: 'A valid email and a password of 8-128 characters are required.' });
  }
  try {
    const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) return res.status(409).json({ error: 'An account with that email already exists.' });
    const [insert] = await pool.execute(
      'INSERT INTO users (email, password_hash, is_confirmed, role) VALUES (?, ?, TRUE, ?)',
      [email, await bcrypt.hash(password, 12), role]
    );
    res.status(201).json({ data: { id: insert.insertId, email, role, isConfirmed: true } });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    next(error);
  }
});

router.patch('/users/:id', async (req, res, next) => {
  const id = positiveId(req.params.id);
  const role = req.body && req.body.role;
  if (!id) return res.status(400).json({ error: 'User id must be a positive integer.' });
  if (!roles.has(role)) return res.status(400).json({ error: 'role must be admin or user.' });
  if (id === req.userId) return res.status(400).json({ error: 'You cannot change your own role.' });
  try {
    const [rows] = await pool.execute('SELECT role FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Account not found.' });
    if (rows[0].role === 'admin' && role === 'user' && (await adminCount()) <= 1) {
      return res.status(400).json({ error: 'The last administrator cannot be demoted.' });
    }
    await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, id]);
    res.json({ data: { id, role } });
  } catch (error) {
    next(error);
  }
});

// Lets an administrator issue a new password for a locked-out account.
router.post('/users/:id/password', async (req, res, next) => {
  const id = positiveId(req.params.id);
  const password = passwordValue(req.body && req.body.password);
  if (!id) return res.status(400).json({ error: 'User id must be a positive integer.' });
  if (!password) return res.status(400).json({ error: 'A password of 8-128 characters is required.' });
  try {
    const [result] = await pool.execute(
      'UPDATE users SET password_hash = ?, is_confirmed = TRUE WHERE id = ?',
      [await bcrypt.hash(password, 12), id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Account not found.' });
    res.json({ message: 'Password updated for that account.' });
  } catch (error) {
    next(error);
  }
});

router.delete('/users/:id', async (req, res, next) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'User id must be a positive integer.' });
  if (id === req.userId) return res.status(400).json({ error: 'You cannot delete your own account.' });
  try {
    const [rows] = await pool.execute('SELECT role FROM users WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Account not found.' });
    if (rows[0].role === 'admin' && (await adminCount()) <= 1) {
      return res.status(400).json({ error: 'The last administrator cannot be deleted.' });
    }
    await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    res.json({ message: 'Account deleted.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
