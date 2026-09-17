const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { ensureColumn, tableExists } = require('../config/schema');

const router = express.Router();
const tokens = new Map();
const passwordResetCodes = new Map();
const tokenLifetimeMs = 8 * 60 * 60 * 1000;
const confirmationLifetimeMs =
  Number(process.env.CONFIRMATION_CODE_EXPIRY_MINUTES || 30) * 60 * 1000;
const resetCodeLifetimeMs = confirmationLifetimeMs;

// Administrator status comes from configuration only. A request body can never
// grant the admin role, which is what prevents self-promotion through the API.
const adminEmails = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const allowRegistration = String(process.env.ALLOW_REGISTRATION || '').toLowerCase() === 'true';

function isAdminEmail(email) {
  return adminEmails.has(String(email || '').trim().toLowerCase());
}

function emailValue(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 255 ? email : null;
}

function passwordValue(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 ? value : null;
}

function issueToken(userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { userId, role, expiresAt: Date.now() + tokenLifetimeMs });
  return token;
}

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header);
  const session = match ? tokens.get(match[1]) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (match) tokens.delete(match[1]);
    return res.status(401).json({ error: 'A valid login is required.' });
  }
  req.userId = session.userId;
  req.userRole = session.role;
  req.authToken = match[1];
  next();
}

// Re-reads the role from the database on every admin request so a demotion or a
// deleted account takes effect immediately, instead of trusting an older token.
async function requireAdmin(req, res, next) {
  try {
    const [rows] = await pool.execute('SELECT role FROM users WHERE id = ?', [req.userId]);
    if (!rows.length || rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Administrator access is required.' });
    }
    req.userRole = 'admin';
    next();
  } catch (error) {
    next(error);
  }
}

// Adds the role columns to older databases and provisions every configured
// administrator account, so admins exist before anyone can register.
async function initializeUserTable() {
  if (!(await tableExists('users'))) {
    console.warn('The users table is missing. Run schema.sql before starting the server.');
    return;
  }
  await ensureColumn('users', 'role', "ENUM('admin', 'user') NOT NULL DEFAULT 'user'");
  await ensureColumn('users', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
  for (const email of adminEmails) {
    const [rows] = await pool.execute('SELECT id, role FROM users WHERE email = ?', [email]);
    if (rows.length) {
      if (rows[0].role !== 'admin') {
        await pool.execute("UPDATE users SET role = 'admin' WHERE id = ?", [rows[0].id]);
        console.log(`Promoted ${email} to administrator.`);
      }
      continue;
    }
    const seedPassword = process.env.ADMIN_PASSWORD;
    if (!seedPassword || seedPassword.length < 8) {
      console.warn(`Administrator ${email} does not exist yet. Set ADMIN_PASSWORD (8+ characters) to create it.`);
      continue;
    }
    await pool.execute(
      "INSERT INTO users (email, password_hash, is_confirmed, role) VALUES (?, ?, TRUE, 'admin')",
      [email, await bcrypt.hash(seedPassword, 12)]
    );
    console.log(`Created administrator account ${email}.`);
  }
}

router.post('/register', async (req, res, next) => {
  if (!allowRegistration) {
    return res.status(403).json({
      error: 'Self-registration is disabled. Ask an administrator to create your account.'
    });
  }
  const email = emailValue(req.body && req.body.email);
  const password = passwordValue(req.body && req.body.password);
  if (!email || !password) {
    return res.status(400).json({ error: 'A valid email and a password of 8-128 characters are required.' });
  }
  if (isAdminEmail(email)) {
    return res.status(409).json({ error: 'That email address is reserved for an administrator account.' });
  }

  const confirmationCode = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + confirmationLifetimeMs;
  const storedCode = `${confirmationCode}:${expiresAt}`;

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.execute(
      `INSERT INTO users (email, password_hash, is_confirmed, confirmation_code, role)
       VALUES (?, ?, FALSE, ?, 'user')`,
      [email, passwordHash, storedCode]
    );
    res.status(201).json({
      message: 'Registration saved. Confirm the simulated email before logging in.',
      email,
      simulatedEmail: {
        subject: 'Clan tracker confirmation',
        code: confirmationCode,
        expiresAt: new Date(expiresAt).toISOString()
      }
    });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    next(error);
  }
});

router.post('/confirm', async (req, res, next) => {
  const email = emailValue(req.body && req.body.email);
  const code = typeof (req.body && req.body.code) === 'string' ? req.body.code.trim() : '';
  if (!email || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'A valid email and six-digit confirmation code are required.' });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, confirmation_code AS confirmationCode FROM users WHERE email = ?',
      [email]
    );
    if (!rows.length || !rows[0].confirmationCode) {
      return res.status(400).json({ error: 'No pending confirmation was found for that email.' });
    }
    const [expectedCode, expiryText] = rows[0].confirmationCode.split(':');
    if (expectedCode !== code || Number(expiryText) <= Date.now()) {
      return res.status(400).json({ error: 'The confirmation code is invalid or expired.' });
    }
    await pool.execute(
      'UPDATE users SET is_confirmed = TRUE, confirmation_code = NULL WHERE id = ?',
      [rows[0].id]
    );
    res.json({ message: 'Email confirmed. You can now log in.' });
  } catch (error) {
    next(error);
  }
});

// Generate a simulated reset code for an existing admin account.
router.post('/forgot-password', async (req, res, next) => {
  const email = emailValue(req.body && req.body.email);
  if (!email) return res.status(400).json({ error: 'A valid email is required.' });

  try {
    const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (!rows.length) return res.status(404).json({ error: 'User does not exist' });

    const code = String(crypto.randomInt(100000, 1000000));
    const expiresAt = Date.now() + resetCodeLifetimeMs;
    passwordResetCodes.set(email, { code, expiresAt });
    res.json({
      message: 'A password reset code was generated.',
      simulatedEmail: { subject: 'Clan tracker password reset', code, expiresAt: new Date(expiresAt).toISOString() }
    });
  } catch (error) {
    next(error);
  }
});

// Verify the simulated reset code and replace the stored bcrypt password hash.
router.post('/reset-password', async (req, res, next) => {
  const email = emailValue(req.body && req.body.email);
  const code = typeof (req.body && req.body.code) === 'string' ? req.body.code.trim() : '';
  const password = passwordValue(req.body && req.body.password);
  if (!email || !/^\d{6}$/.test(code) || !password) {
    return res.status(400).json({ error: 'Email, six-digit code, and an 8-128 character password are required.' });
  }
  if (password !== (req.body && req.body.confirmPassword)) {
    return res.status(400).json({ error: 'Password and confirmation password must match.' });
  }

  const reset = passwordResetCodes.get(email);
  if (!reset || reset.expiresAt <= Date.now() || reset.code !== code) {
    if (reset && reset.expiresAt <= Date.now()) passwordResetCodes.delete(email);
    return res.status(400).json({ error: 'The password reset code is invalid or expired.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'UPDATE users SET password_hash = ?, is_confirmed = TRUE WHERE email = ?',
      [passwordHash, email]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'User does not exist' });
    passwordResetCodes.delete(email);
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  const email = emailValue(req.body && req.body.email);
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  try {
    const [rows] = await pool.execute(
      'SELECT id, email, password_hash AS passwordHash, is_confirmed AS isConfirmed, role FROM users WHERE email = ?',
      [email]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'User does not exist' });
    }

    let passwordMatches = false;
    try {
      passwordMatches = await bcrypt.compare(password, rows[0].passwordHash);
    } catch (error) {
      console.error('Password comparison failed:', error);
    }
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    if (!rows[0].isConfirmed) {
      return res.status(403).json({ error: 'Confirm the simulated email before logging in.' });
    }
    // Configuration decides who is an administrator. Existing admins are kept so a
    // manual promotion is never undone by simply logging in.
    const role = rows[0].role === 'admin' || isAdminEmail(email) ? 'admin' : 'user';
    if (rows[0].role !== role) {
      await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, rows[0].id]);
    }
    const token = issueToken(rows[0].id, role);
    res.json({ data: { token, user: { id: rows[0].id, email: rows[0].email, role } } });
  } catch (error) {
    next(error);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT id, email, role FROM users WHERE id = ?', [req.userId]);
    if (!rows.length) {
      tokens.delete(req.authToken);
      return res.status(401).json({ error: 'That account no longer exists.' });
    }
    res.json({ data: rows[0] });
  } catch (error) {
    next(error);
  }
});

// Lets any signed-in account change its own password from the My account tab.
router.post('/change-password', requireAuth, async (req, res, next) => {
  const currentPassword = typeof (req.body && req.body.currentPassword) === 'string' ? req.body.currentPassword : '';
  const newPassword = passwordValue(req.body && req.body.newPassword);
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Your current password and a new 8-128 character password are required.' });
  }
  try {
    const [rows] = await pool.execute('SELECT password_hash AS passwordHash FROM users WHERE id = ?', [req.userId]);
    if (!rows.length) {
      tokens.delete(req.authToken);
      return res.status(401).json({ error: 'That account no longer exists.' });
    }
    if (!(await bcrypt.compare(currentPassword, rows[0].passwordHash))) {
      return res.status(401).json({ error: 'Your current password is incorrect.' });
    }
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [
      await bcrypt.hash(newPassword, 12),
      req.userId
    ]);
    res.json({ message: 'Password updated.' });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', requireAuth, (req, res) => {
  tokens.delete(req.authToken);
  res.json({ message: 'Logged out.' });
});

module.exports = { router, requireAuth, requireAdmin, initializeUserTable, allowRegistration };
