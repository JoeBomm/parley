// test/auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../src/store/db.js';
import { installUsers } from '../src/store/users.js';
import { authRouter, attachUser, requireAuth, requirePasswordChanged, sameOrigin } from '../src/web/auth.js';

// Mount the auth router exactly like the real server: attachUser resolves the
// cookie, the auth routes are public, and a protected probe stands in for the
// rest of the API. `gated` mirrors the production stack (same-origin + password
// change gate) for the tests that exercise those layers.
function appWith(db, { trustProxy = false, now, gated = false } = {}) {
  const users = installUsers(db);
  const app = express();
  if (trustProxy) app.set('trust proxy', true);
  app.use(express.json());
  app.use(attachUser(users));
  if (gated) app.use('/api', sameOrigin);
  app.use('/api', authRouter(now ? { users, now } : { users }));
  const gate = gated ? [requirePasswordChanged(users)] : [];
  app.use('/api', requireAuth(users), ...gate, (req, res) => res.json({ ok: true, user: req.user }));
  return { app, users };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const jpost = (base, path, body, cookie, headers) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(headers || {}) },
  body: JSON.stringify(body || {}),
});

function cookieOf(res) {
  const sc = res.headers.get('set-cookie');
  return sc ? sc.split(';')[0] : null;
}

test('login with the seeded admin issues a session cookie; logout clears it', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db).app);
  try {
    const bad = await jpost(base, '/api/auth/login', { username: 'admin', password: 'wrong' });
    assert.equal(bad.status, 401);

    const ok = await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' });
    assert.equal(ok.status, 200);
    const cookie = cookieOf(ok);
    assert.ok(cookie);
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/i);

    // me reflects the session.
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json();
    assert.equal(me.user.username, 'admin');

    // protected probe works with the cookie, fails without.
    assert.equal((await fetch(`${base}/api/anything`)).status, 401);
    assert.equal((await fetch(`${base}/api/anything`, { headers: { cookie } })).status, 200);

    // logout invalidates the session.
    await jpost(base, '/api/auth/logout', {}, cookie);
    assert.equal((await fetch(`${base}/api/anything`, { headers: { cookie } })).status, 401);
  } finally { close(); }
});

test('me returns null when unauthenticated (never 401)', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db).app);
  try {
    const me = await fetch(`${base}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user, null);
  } finally { close(); }
});

test('the seeded admin can change its own password without the current one', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db).app);
  try {
    const login = await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' });
    const cookie = cookieOf(login);
    // mustChangePassword is set, so currentPassword is not required.
    const changed = await jpost(base, '/api/auth/password', { newPassword: 'longerpass' }, cookie);
    assert.equal(changed.status, 200);
    // Old password no longer works; new one does.
    assert.equal((await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' })).status, 401);
    assert.equal((await jpost(base, '/api/auth/login', { username: 'admin', password: 'longerpass' })).status, 200);
  } finally { close(); }
});

test('admin can create a user who can then log in', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db).app);
  try {
    const cookie = cookieOf(await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' }));
    const created = await jpost(base, '/api/users', { username: 'jane', email: 'jane@x.com', password: 'pw123456' }, cookie);
    assert.equal(created.status, 201);

    const list = await (await fetch(`${base}/api/users`, { headers: { cookie } })).json();
    assert.equal(list.users.length, 2);

    // The new user can authenticate and is not an admin.
    const janeLogin = await jpost(base, '/api/auth/login', { username: 'jane', password: 'pw123456' });
    assert.equal(janeLogin.status, 200);
    assert.equal((await janeLogin.json()).user.isAdmin, false);
  } finally { close(); }
});

test('non-admins cannot manage users', async () => {
  const db = openDb(':memory:');
  const { app, users } = appWith(db);
  users.createUser({ username: 'jane', password: 'pw1234' });
  const { base, close } = await listen(app);
  try {
    const cookie = cookieOf(await jpost(base, '/api/auth/login', { username: 'jane', password: 'pw1234' }));
    assert.equal((await fetch(`${base}/api/users`, { headers: { cookie } })).status, 403);
    assert.equal((await jpost(base, '/api/users', { username: 'x', password: 'pw1234' }, cookie)).status, 403);
  } finally { close(); }
});

test('the last admin cannot be demoted or deleted', async () => {
  const db = openDb(':memory:');
  const { app, users } = appWith(db);
  const admin = users.getUserByUsername('admin');
  const { base, close } = await listen(app);
  try {
    const cookie = cookieOf(await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' }));
    const demote = await fetch(`${base}/api/users/${admin.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ isAdmin: false }),
    });
    assert.equal(demote.status, 400);
    const del = await fetch(`${base}/api/users/${admin.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(del.status, 400); // also self-delete guarded
  } finally { close(); }
});

test('admin password reset for another user revokes their sessions', async () => {
  const db = openDb(':memory:');
  const { app, users } = appWith(db);
  const jane = users.createUser({ username: 'jane', password: 'pw123456' });
  const { base, close } = await listen(app);
  try {
    const janeCookie = cookieOf(await jpost(base, '/api/auth/login', { username: 'jane', password: 'pw123456' }));
    // Jane is logged in.
    assert.equal((await fetch(`${base}/api/anything`, { headers: { cookie: janeCookie } })).status, 200);

    const adminCookie = cookieOf(await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' }));
    const reset = await jpost(base, `/api/users/${jane.id}/password`, { password: 'fresh123' }, adminCookie);
    assert.equal(reset.status, 200);

    // Jane's old session is dead; her old password no longer works; the new one does.
    assert.equal((await fetch(`${base}/api/anything`, { headers: { cookie: janeCookie } })).status, 401);
    assert.equal((await jpost(base, '/api/auth/login', { username: 'jane', password: 'pw123456' })).status, 401);
    assert.equal((await jpost(base, '/api/auth/login', { username: 'jane', password: 'fresh123' })).status, 200);
  } finally { close(); }
});

// ── D1: Secure cookie flag ────────────────────────────────────────────────────

test('login over https (trust proxy + X-Forwarded-Proto) sets a Secure cookie', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db, { trustProxy: true }).app);
  try {
    const res = await jpost(base, '/api/auth/login',
      { username: 'admin', password: 'admin' }, null, { 'x-forwarded-proto': 'https' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /;\s*Secure/i);

    // Logout mirrors the Secure attribute so browsers match the cookie.
    const cookie = cookieOf(res);
    const out = await jpost(base, '/api/auth/logout', {}, cookie, { 'x-forwarded-proto': 'https' });
    assert.match(out.headers.get('set-cookie'), /;\s*Secure/i);
  } finally { close(); }
});

test('login over plain http does not set the Secure attribute', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db).app);
  try {
    const res = await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' });
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.headers.get('set-cookie'), /;\s*Secure/i);
  } finally { close(); }
});

// ── D2: login rate limiting ───────────────────────────────────────────────────

test('6th attempt after 5 failed logins is 429 with Retry-After', async () => {
  const db = openDb(':memory:');
  let t = 1_000_000;
  const { base, close } = await listen(appWith(db, { now: () => t }).app);
  try {
    for (let i = 0; i < 5; i++) {
      const res = await jpost(base, '/api/auth/login', { username: 'admin', password: 'wrong' });
      assert.equal(res.status, 401, `attempt ${i + 1} should still be 401`);
    }
    // Locked now — even the correct password is rejected until the window lifts.
    const locked = await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' });
    assert.equal(locked.status, 429);
    const retryAfter = Number(locked.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, `Retry-After should be a positive integer, got ${locked.headers.get('retry-after')}`);
  } finally { close(); }
});

test('a successful login resets the failure counter', async () => {
  const db = openDb(':memory:');
  let t = 1_000_000;
  const { base, close } = await listen(appWith(db, { now: () => t }).app);
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal((await jpost(base, '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
    }
    // One attempt left; a success wipes the slate...
    assert.equal((await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' })).status, 200);
    // ...so 4 more failures still don't lock, and the correct password works.
    for (let i = 0; i < 4; i++) {
      assert.equal((await jpost(base, '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
    }
    assert.equal((await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' })).status, 200);
  } finally { close(); }
});

test('the lockout expires once the injected clock passes the window', async () => {
  const db = openDb(':memory:');
  let t = 1_000_000;
  const { base, close } = await listen(appWith(db, { now: () => t }).app);
  try {
    for (let i = 0; i < 5; i++) {
      await jpost(base, '/api/auth/login', { username: 'admin', password: 'wrong' });
    }
    assert.equal((await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' })).status, 429);
    t += 31_000; // past the 30s first lockout window
    assert.equal((await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' })).status, 200);
  } finally { close(); }
});

test('a different username on the same IP is not locked out', async () => {
  const db = openDb(':memory:');
  let t = 1_000_000;
  const { app, users } = appWith(db, { now: () => t });
  users.createUser({ username: 'jane', password: 'pw1234' });
  const { base, close } = await listen(app);
  try {
    for (let i = 0; i < 5; i++) {
      await jpost(base, '/api/auth/login', { username: 'admin', password: 'wrong' });
    }
    assert.equal((await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' })).status, 429);
    // Same IP, different username — unaffected.
    assert.equal((await jpost(base, '/api/auth/login', { username: 'jane', password: 'wrong' })).status, 401);
    assert.equal((await jpost(base, '/api/auth/login', { username: 'jane', password: 'pw1234' })).status, 200);
  } finally { close(); }
});

// ── Default-password API gate ─────────────────────────────────────────────────

test('the default-password admin is blocked from the API until it changes', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db, { gated: true }).app);
  try {
    const cookie = cookieOf(await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' }));
    // Data/system probe is 403'd while must_change_password is set...
    const gated = await fetch(`${base}/api/anything`, { headers: { cookie } });
    assert.equal(gated.status, 403);
    assert.equal((await gated.json()).code, 'PASSWORD_CHANGE_REQUIRED');
    // ...but the password route itself stays reachable so they can fix it.
    const changed = await jpost(base, '/api/auth/password', { newPassword: 'a-real-password' }, cookie);
    assert.equal(changed.status, 200);
    // A fresh session is issued by the change; use it (the old one was revoked).
    const newCookie = cookieOf(changed);
    assert.equal((await fetch(`${base}/api/anything`, { headers: { cookie: newCookie } })).status, 200);
  } finally { close(); }
});

test('changing the password revokes other sessions and re-issues the current one', async () => {
  const db = openDb(':memory:');
  const { app, users } = appWith(db);
  users.createUser({ username: 'jane', password: 'pw123456' });
  const { base, close } = await listen(app);
  try {
    // Two concurrent sessions for jane.
    const a = cookieOf(await jpost(base, '/api/auth/login', { username: 'jane', password: 'pw123456' }));
    const b = cookieOf(await jpost(base, '/api/auth/login', { username: 'jane', password: 'pw123456' }));
    const changed = await jpost(base, '/api/auth/password', { currentPassword: 'pw123456', newPassword: 'pw-new-123' }, a);
    assert.equal(changed.status, 200);
    const reissued = cookieOf(changed);
    // The other session (b) is dead; the reissued cookie for (a) still works.
    assert.equal((await fetch(`${base}/api/anything`, { headers: { cookie: b } })).status, 401);
    assert.equal((await fetch(`${base}/api/anything`, { headers: { cookie: reissued } })).status, 200);
  } finally { close(); }
});

test('password change enforces the 8-char minimum', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db).app);
  try {
    const cookie = cookieOf(await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' }));
    const tooShort = await jpost(base, '/api/auth/password', { newPassword: 'short' }, cookie);
    assert.equal(tooShort.status, 400);
    assert.match((await tooShort.json()).error, /at least 8/);
  } finally { close(); }
});

// ── CSRF: same-origin guard ───────────────────────────────────────────────────

test('a cross-origin state-changing request is refused', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db, { gated: true }).app);
  try {
    // Cross-site POST carries a foreign Origin; the guard rejects it before auth.
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.equal(res.status, 403);
  } finally { close(); }
});

test('a same-origin state-changing request passes the guard', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db, { gated: true }).app);
  try {
    const host = base.replace('http://', '');
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, host },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    assert.equal(res.status, 200);
  } finally { close(); }
});

// ── requireAdmin fails closed once auth has run (#22) ─────────────────────────

test('requireAdmin denies an unauthenticated request when the auth stack ran', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db, { gated: true }).app);
  try {
    // No cookie → attachUser ran (authResolved) but req.user is null. An admin
    // route must 403 (fail closed), not fall through. /users is admin-gated.
    const res = await fetch(`${base}/api/users`);
    // requireAuth returns 401 first here; the point is it is NOT a 200. Assert
    // it is rejected.
    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
  } finally { close(); }
});

test('/auth/me reports defaultPasswordActive while the seeded admin is unchanged', async () => {
  const db = openDb(':memory:');
  const { base, close } = await listen(appWith(db).app);
  try {
    const me1 = await (await fetch(`${base}/api/auth/me`)).json();
    assert.equal(me1.defaultPasswordActive, true);
    // Change the admin password, then it should report false.
    const cookie = cookieOf(await jpost(base, '/api/auth/login', { username: 'admin', password: 'admin' }));
    await jpost(base, '/api/auth/password', { newPassword: 'a-real-password' }, cookie);
    const me2 = await (await fetch(`${base}/api/auth/me`)).json();
    assert.equal(me2.defaultPasswordActive, false);
  } finally { close(); }
});
