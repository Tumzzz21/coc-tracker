#!/usr/bin/env node
/*
 * Promotes or creates an account out of band, which is how an administrator is
 * restored if the configured account is missing or locked out.
 *
 *   npm run set-admin -- --email=you@example.com --password=secret
 *   npm run set-admin -- --email=helper@example.com            (promote to admin)
 *   npm run set-admin -- --email=helper@example.com --role=user (demote to user)
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { ensureColumn, tableExists } = require('../config/schema');

function argument(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function main() {
  const email = (argument('email') || '').trim().toLowerCase();
  const password = argument('password');
  const role = argument('role') === 'user' ? 'user' : 'admin';

  if (!email) {
    console.error('Usage: npm run set-admin -- --email=you@example.com [--password=secret] [--role=admin|user]');
    process.exitCode = 1;
    return;
  }
  if (password && password.length < 8) {
    console.error('The password must be at least 8 characters.');
    process.exitCode = 1;
    return;
  }
  if (!(await tableExists('users'))) {
    console.error('The users table is missing. Apply schema.sql first.');
    process.exitCode = 1;
    return;
  }

  await ensureColumn('users', 'role', "ENUM('admin', 'user') NOT NULL DEFAULT 'user'");
  const [rows] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);

  if (rows.length) {
    const assignments = ['role = ?', 'is_confirmed = TRUE'];
    const params = [role];
    if (password) {
      assignments.push('password_hash = ?', 'confirmation_code = NULL');
      params.push(await bcrypt.hash(password, 12));
    }
    params.push(rows[0].id);
    await pool.execute(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
    console.log(`${email} is now ${role}${password ? ' with the supplied password' : ''}.`);
    return;
  }

  if (!password) {
    console.error(`No account exists for ${email}. Pass --password=... to create it.`);
    process.exitCode = 1;
    return;
  }
  await pool.execute(
    'INSERT INTO users (email, password_hash, is_confirmed, role) VALUES (?, ?, TRUE, ?)',
    [email, await bcrypt.hash(password, 12), role]
  );
  console.log(`Created ${role} account ${email}.`);
}

main()
  .catch((error) => {
    console.error('Unable to update the account:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
