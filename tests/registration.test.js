'use strict';
// Registration rules: the configured administrator email is reserved, and every
// self-registered account is created as a read-only user.
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.ADMIN_EMAILS = 'aldrinlance21@gmail.com';
process.env.ALLOW_REGISTRATION = 'true';

function createFakeDatabase() {
  const users = [];
  let nextId = 1;

  const pool = {
    async execute(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      const lower = text.toLowerCase();

      if (lower.includes('information_schema')) return [[{ count: 0 }], []];
      if (lower.includes('where email = ?')) {
        const found = users.filter((row) => row.email === String(params[0]).toLowerCase());
        if (lower.includes('confirmation_code as confirmationcode')) {
          return [found.map((row) => ({ id: row.id, confirmationCode: row.confirmation_code })), []];
        }
        return [found.map((row) => ({ id: row.id, role: row.role })), []];
      }
      if (lower.startsWith('insert into users')) {
        const row = {
          id: nextId++,
          email: String(params[0]).toLowerCase(),
          password_hash: params[1],
          confirmation_code: params[2] ?? null,
          is_confirmed: 0,
          role: 'user'
        };
        users.push(row);
        return [{ insertId: row.id, affectedRows: 1 }, []];
      }
      if (lower.startsWith('update users set is_confirmed = true')) {
        const row = users.find((item) => item.id === Number(params[0]));
        if (!row) return [{ affectedRows: 0 }, []];
        row.is_confirmed = 1;
        row.confirmation_code = null;
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    }
  };

  return { pool, users };
}

const database = createFakeDatabase();
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: database.pool };

const app = require('../server');

let server;
let baseUrl;

async function request(path, body) {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('the configured administrator email cannot be self-registered', async () => {
  const response = await request('/api/auth/register', {
    email: 'aldrinlance21@gmail.com',
    password: 'password123'
  });
  assert.equal(response.status, 409);
  assert.match(response.payload.error, /reserved for an administrator/);
  assert.equal(database.users.length, 0, 'the reserved address must not create an account');
});

test('a self-registered account is always a read-only user', async () => {
  const response = await request('/api/auth/register', {
    email: 'newcomer@example.com',
    password: 'password123',
    role: 'admin'
  });
  assert.equal(response.status, 201);
  assert.equal(database.users.length, 1);
  assert.equal(database.users[0].role, 'user', 'a role in the body must be ignored');
  assert.match(response.payload.simulatedEmail.code, /^\d{6}$/);
});

test('the confirmation flow still completes for a registered account', async () => {
  const pending = database.users.find((row) => row.email === 'newcomer@example.com');
  assert.ok(pending, 'the account should exist before confirming');
  const code = pending.confirmation_code.split(':')[0];
  const response = await request('/api/auth/confirm', { email: 'newcomer@example.com', code });
  assert.equal(response.status, 200);
  assert.equal(pending.is_confirmed, 1);
});