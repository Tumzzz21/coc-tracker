'use strict';
// Verifies the role boundary end to end through the real Express app, using a
// small in-memory stand-in for MySQL so the suite runs without a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const bcrypt = require('bcryptjs');

process.env.ADMIN_EMAILS = 'aldrinlance21@gmail.com';
process.env.ALLOW_REGISTRATION = 'false';

function createFakeDatabase() {
  const users = [];
  let nextId = 1;

  function addUser({ email, passwordHash, role = 'user', isConfirmed = true }) {
    const row = {
      id: nextId++,
      email: String(email).toLowerCase(),
      password_hash: passwordHash,
      is_confirmed: isConfirmed ? 1 : 0,
      confirmation_code: null,
      role,
      created_at: new Date()
    };
    users.push(row);
    return row;
  }

  const pool = {
    async execute(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      const lower = text.toLowerCase();

      if (lower.includes('information_schema')) return [[{ count: 0 }], []];
      if (lower.startsWith('select count(*) as count from users')) {
        return [[{ count: users.filter((row) => row.role === 'admin').length }], []];
      }
      if (lower.includes('where email = ?')) {
        const found = users.filter((row) => row.email === String(params[0]).toLowerCase());
        if (lower.includes('password_hash')) {
          // Mirrors the aliases the login query selects.
          return [found.map((row) => ({
            id: row.id,
            email: row.email,
            passwordHash: row.password_hash,
            isConfirmed: row.is_confirmed,
            role: row.role
          })), []];
        }
        return [found.map((row) => ({ id: row.id, role: row.role })), []];
      }
      if (lower.startsWith('select role from users where id = ?')) {
        return [users.filter((row) => row.id === Number(params[0])).map((row) => ({ role: row.role })), []];
      }
      if (lower.startsWith('select id, email, role from users where id = ?')) {
        return [users.filter((row) => row.id === Number(params[0])).map((row) => ({ id: row.id, email: row.email, role: row.role })), []];
      }
      if (lower.startsWith('select password_hash as passwordhash from users where id = ?')) {
        return [users.filter((row) => row.id === Number(params[0])).map((row) => ({ passwordHash: row.password_hash })), []];
      }
      if (lower.startsWith('select id, email, role') && lower.includes('order by')) {
        return [users.map((row) => ({ id: row.id, email: row.email, role: row.role, isConfirmed: row.is_confirmed, createdAt: row.created_at })), []];
      }
      if (lower.startsWith('insert into users')) {
        // The admin API passes the role as the third parameter; self-registration
        // hard-codes 'user' in the SQL and passes the confirmation code instead.
        const fromAdminApi = lower.includes('(email, password_hash, is_confirmed, role)');
        const role = fromAdminApi && params[2] ? params[2] : 'user';
        const row = addUser({ email: params[0], passwordHash: params[1], role });
        if (!fromAdminApi) row.confirmation_code = params[2] ?? null;
        return [{ insertId: row.id, affectedRows: 1 }, []];
      }
      if (lower.startsWith('update users set role = ? where id = ?')) {
        const row = users.find((item) => item.id === Number(params[1]));
        if (!row) return [{ affectedRows: 0 }, []];
        row.role = params[0];
        return [{ affectedRows: 1 }, []];
      }
      if (lower.startsWith('delete from users where id = ?')) {
        const index = users.findIndex((row) => row.id === Number(params[0]));
        if (index === -1) return [{ affectedRows: 0 }, []];
        users.splice(index, 1);
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    },
    async getConnection() {
      return { execute: pool.execute, release() {} };
    }
  };

  return { addUser, pool, users };
}

const database = createFakeDatabase();
const dbPath = require.resolve('../config/db');
// Injected before the server loads so every route uses the in-memory pool.
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: database.pool };

const app = require('../server');

let server;
let baseUrl;
const tokens = {};

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

test.before(async () => {
  database.addUser({
    email: 'aldrinlance21@gmail.com',
    passwordHash: await bcrypt.hash('adminpass123', 12),
    role: 'admin'
  });
  database.addUser({
    email: 'member@example.com',
    passwordHash: await bcrypt.hash('userpass123', 12),
    role: 'user'
  });

  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const admin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'aldrinlance21@gmail.com', password: 'adminpass123' }
  });
  assert.equal(admin.status, 200, 'the seeded administrator should be able to log in');
  assert.equal(admin.payload.data.user.role, 'admin');
  tokens.admin = admin.payload.data.token;

  const user = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'member@example.com', password: 'userpass123' }
  });
  assert.equal(user.status, 200, 'the seeded user should be able to log in');
  assert.equal(user.payload.data.user.role, 'user');
  tokens.user = user.payload.data.token;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('a request without a token is rejected', async () => {
  const response = await request('/api/auth/me');
  assert.equal(response.status, 401);
});

test('a read-only user can view the roster', async () => {
  const response = await request('/api/members', { token: tokens.user });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.payload.data));
});

test('a read-only user cannot add a member', async () => {
  const response = await request('/api/members', {
    method: 'POST',
    token: tokens.user,
    body: { playerName: 'Intruder', playerTag: '#AAA111', townHallLevel: 10, role: 'member' }
  });
  assert.equal(response.status, 403);
  assert.match(response.payload.error, /Administrator access/);
});

test('a read-only user cannot log war activity', async () => {
  const response = await request('/api/wars', {
    method: 'POST',
    token: tokens.user,
    body: { memberId: 1, warDate: '2026-09-01', attacksUsed: 2, missedAttack: false }
  });
  assert.equal(response.status, 403);
});

test('a read-only user cannot change the background', async () => {
  const response = await request('/api/settings', {
    method: 'PUT',
    token: tokens.user,
    body: { bgImageUrl: 'https://example.com/clan.jpg' }
  });
  assert.equal(response.status, 403);
});

test('a read-only user cannot reach the admin API', async () => {
  assert.equal((await request('/api/admin/users', { token: tokens.user })).status, 403);
  const create = await request('/api/admin/users', {
    method: 'POST',
    token: tokens.user,
    body: { email: 'sneaky@example.com', password: 'password123', role: 'admin' }
  });
  assert.equal(create.status, 403);
});

test('an administrator can list accounts', async () => {
  const response = await request('/api/admin/users', { token: tokens.admin });
  assert.equal(response.status, 200);
  const emails = response.payload.data.map((account) => account.email);
  assert.ok(emails.includes('aldrinlance21@gmail.com'));
  assert.ok(emails.includes('member@example.com'));
});

test('an unknown role in the body cannot grant administrator access', async () => {
  const created = await request('/api/admin/users', {
    method: 'POST',
    token: tokens.admin,
    body: { email: 'climber@example.com', password: 'password123', role: 'superuser' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.data.role, 'user', 'only admin/user are accepted; anything else becomes user');
});

test('the administrator email cannot be used for a second account', async () => {
  const response = await request('/api/admin/users', {
    method: 'POST',
    token: tokens.admin,
    body: { email: 'aldrinlance21@gmail.com', password: 'password123', role: 'user' }
  });
  assert.equal(response.status, 409);
});

test('self-registration is refused while it is disabled', async () => {
  const response = await request('/api/auth/register', {
    method: 'POST',
    body: { email: 'newcomer@example.com', password: 'password123' }
  });
  assert.equal(response.status, 403);
  assert.match(response.payload.error, /Self-registration is disabled/);
});

test('an administrator cannot change or delete their own account', async () => {
  const me = await request('/api/auth/me', { token: tokens.admin });
  const change = await request(`/api/admin/users/${me.payload.data.id}`, {
    method: 'PATCH',
    token: tokens.admin,
    body: { role: 'user' }
  });
  assert.equal(change.status, 400);
  const remove = await request(`/api/admin/users/${me.payload.data.id}`, {
    method: 'DELETE',
    token: tokens.admin
  });
  assert.equal(remove.status, 400);
});

test('a demoted administrator loses access immediately, without logging in again', async () => {
  const created = await request('/api/admin/users', {
    method: 'POST',
    token: tokens.admin,
    body: { email: 'helper@example.com', password: 'password123', role: 'admin' }
  });
  assert.equal(created.status, 201);

  const helper = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'helper@example.com', password: 'password123' }
  });
  assert.equal(helper.payload.data.user.role, 'admin');
  const helperToken = helper.payload.data.token;
  assert.equal((await request('/api/admin/users', { token: helperToken })).status, 200);

  const demote = await request(`/api/admin/users/${created.payload.data.id}`, {
    method: 'PATCH',
    token: tokens.admin,
    body: { role: 'user' }
  });
  assert.equal(demote.status, 200);

  assert.equal(
    (await request('/api/admin/users', { token: helperToken })).status,
    403,
    'the role is re-read from the database on every admin request'
  );
});

test('the background URL rejects characters that could inject styles', async () => {
  const injected = await request('/api/settings', {
    method: 'PUT',
    token: tokens.admin,
    body: { bgImageUrl: 'https://example.com/a.jpg") ; background-image:none' }
  });
  assert.equal(injected.status, 400);

  const valid = await request('/api/settings', {
    method: 'PUT',
    token: tokens.admin,
    body: { bgImageUrl: 'https://example.com/ok.jpg' }
  });
  assert.equal(valid.status, 200);
});
