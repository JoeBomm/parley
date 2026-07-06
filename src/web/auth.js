// src/web/auth.js
// Session-cookie auth for the dashboard API. Dependency-free: a single httpOnly
// cookie carries an opaque session token resolved server-side against the
// `sessions` table (see src/store/users.js).
//
//   • requireAuth(users)        — Express middleware; 401s unauthenticated calls
//   • authRouter({ users })     — /api/auth/* (login, logout, me, password) +
//                                  /api/users (admin CRUD)
//
// The web server binds localhost by default, but auth makes the dashboard safe
// to expose (e.g. behind a reverse proxy / Docker port map).

import { Router } from 'express';

const COOKIE = 'parley_session';
// Minimum password length, enforced on every set/change/reset path. Kept modest
// for a self-hosted tool but well above the old 4-char floor.
export const PASSWORD_MIN = 8;

// Minimal cookie parser — we only need our one session cookie, so no dep.
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, expiresAt, secure) {
  const attrs = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  // Secure only over https (so localhost http dev still works). Express sets
  // req.secure from the connection / X-Forwarded-Proto when trust proxy is on.
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res, secure) {
  const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Expires=${new Date(0).toUTCString()}`];
  if (secure) attrs.push('Secure'); // mirror setSessionCookie so browsers match the cookie
  res.append('Set-Cookie', attrs.join('; '));
}

// In-memory login rate limiter — no dep, resets on process restart (fine: its
// job is to blunt online brute force, not to be a durable audit log). Keyed by
// caller-provided string (we use ip + lowercased username). After `maxFailures`
// consecutive failures the key locks out for `lockoutMs`, doubling on each
// subsequent lockout up to `maxLockoutMs`. A success (or going quiet for
// `maxLockoutMs`) clears the slate. `now` is injectable for tests.
export function createLoginLimiter({
  now = () => Date.now(),
  maxFailures = 5,
  lockoutMs = 30_000,
  maxLockoutMs = 15 * 60_000,
} = {}) {
  const entries = new Map(); // key -> { failures, strikes, lockedUntil, lastFailAt }

  // Cheap bound on memory: drop keys that have been quiet long enough that
  // their state would have been forgiven anyway.
  function prune() {
    const t = now();
    for (const [key, e] of entries) {
      if (e.lockedUntil <= t && t - e.lastFailAt > maxLockoutMs) entries.delete(key);
    }
  }

  return {
    // null when allowed, otherwise seconds until the lockout lifts.
    retryAfterSec(key) {
      const e = entries.get(key);
      if (!e || e.lockedUntil <= now()) return null;
      return Math.ceil((e.lockedUntil - now()) / 1000);
    },
    fail(key) {
      if (entries.size > 1000) prune();
      const t = now();
      let e = entries.get(key);
      // Stale entries (quiet past the max lockout) start fresh — old failures
      // shouldn't haunt a user forever.
      if (!e || t - e.lastFailAt > maxLockoutMs) e = { failures: 0, strikes: 0, lockedUntil: 0 };
      e.failures += 1;
      e.lastFailAt = t;
      if (e.failures >= maxFailures) {
        e.failures = 0;
        e.strikes += 1; // exponential backoff per completed lockout cycle
        e.lockedUntil = t + Math.min(lockoutMs * 2 ** (e.strikes - 1), maxLockoutMs);
      }
      entries.set(key, e);
    },
    reset(key) {
      entries.delete(key);
    },
  };
}

// Attaches req.user (or null) from the session cookie. Use before requireAuth
// so optional routes can read the user too.
export function attachUser(users) {
  return (req, _res, next) => {
    const token = readCookie(req, COOKIE);
    req.sessionToken = token;
    req.user = token ? users.getSessionUser(token) : null;
    next();
  };
}

export function requireAuth(_users) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    next();
  };
}

// Gates a route to admin users only. Deliberately permissive when no user is
// attached at all (req.user undefined/null) — that's the signature of the
// standalone/test server, which mounts apiRouter without attachUser/requireAuth
// in front of it. In that mode nobody is authenticated, so there's no admin
// concept to enforce. Once a real user is attached (attachUser ran), a
// non-admin is rejected; an admin passes through.
export function requireAdmin(req, res, next) {
  if (req.user && !req.user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// Blocks the data/system API while the logged-in account still uses its seeded
// default password (must_change_password). Auth routes (login/logout/me/password)
// are mounted *before* this, so the user can still authenticate and set a real
// password — they just can't touch anything else until they do. Without this, a
// reachable instance with the default admin/admin is fully operable by anyone.
// Permissive when no user is attached (standalone/test server), mirroring
// requireAdmin.
export function requirePasswordChanged(_users) {
  return (req, res, next) => {
    if (req.user && req.user.mustChangePassword) {
      return res.status(403).json({
        error: 'Set a new password before using the dashboard.',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
    next();
  };
}

// Same-origin guard for state-changing requests: browsers always attach an
// Origin header on cross-site POST/PUT/PATCH/DELETE, so rejecting a mismatched
// Origin blocks CSRF without tokens. Requests with no Origin (same-origin GETs,
// non-browser API clients, tests) are allowed — they can't be CSRF vectors.
export function sameOrigin(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  let originHost;
  try { originHost = new URL(origin).host; } catch { return res.status(403).json({ error: 'Bad Origin.' }); }
  if (originHost !== req.headers.host) {
    return res.status(403).json({ error: 'Cross-origin request refused.' });
  }
  next();
}

export function authRouter({ users, now = () => Date.now(), loginLimiter = createLoginLimiter({ now }) }) {
  const r = Router();

  // ── Session ────────────────────────────────────────────────────────────────
  r.post('/auth/login', (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    // Rate-limit per (ip, username) so one attacker can't lock everyone out and
    // a distributed guess against one account still trips per-IP keys.
    const limitKey = `${req.ip ?? ''}|${username.toLowerCase()}`;
    const retryAfter = loginLimiter.retryAfterSec(limitKey);
    if (retryAfter !== null) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Too many failed login attempts. Try again in ${retryAfter}s.` });
    }
    const user = users.authenticate(username, password);
    if (!user) {
      loginLimiter.fail(limitKey);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    loginLimiter.reset(limitKey);
    const { token, expiresAt } = users.createSession(user.id);
    setSessionCookie(res, token, expiresAt, req.secure);
    res.json({ ok: true, user });
  });

  r.post('/auth/logout', (req, res) => {
    if (req.sessionToken) users.deleteSession(req.sessionToken);
    clearSessionCookie(res, req.secure);
    res.json({ ok: true });
  });

  // Current user (or null). Drives the frontend's auth gate; never 401s.
  // `authEnabled: true` tells the client this server enforces login (older
  // servers without this route make the client fall back to open mode).
  r.get('/auth/me', (req, res) => {
    res.json({ authEnabled: true, user: req.user || null });
  });

  // Change your own password. Requires the current password unless the account
  // is flagged must_change_password (the seeded default admin's first change).
  // On success every other session for this user is revoked (a password change
  // is the response to a suspected compromise) and the current request gets a
  // fresh session cookie so the user stays logged in here.
  r.post('/auth/password', requireAuth(users), (req, res) => {
    const current = String(req.body?.currentPassword ?? '');
    const next = String(req.body?.newPassword ?? '');
    if (next.length < PASSWORD_MIN) {
      return res.status(400).json({ error: `New password must be at least ${PASSWORD_MIN} characters.` });
    }
    const row = users.getUserByUsername(req.user.username);
    const mustChange = !!row?.must_change_password;
    if (!mustChange) {
      if (!users.authenticate(req.user.username, current)) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
    }
    users.setPassword(req.user.id, next);
    users.deleteUserSessions(req.user.id); // revoke all sessions, including this one
    const { token, expiresAt } = users.createSession(req.user.id); // re-issue for the current request
    setSessionCookie(res, token, expiresAt, req.secure);
    res.json({ ok: true, user: users.getUser(req.user.id) });
  });

  // ── User management (admin) ─────────────────────────────────────────────────
  r.get('/users', requireAuth(users), requireAdmin, (_req, res) => {
    res.json({ users: users.listUsers() });
  });

  r.post('/users', requireAuth(users), requireAdmin, (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const email = req.body?.email ? String(req.body.email).trim() : null;
    const password = String(req.body?.password ?? '');
    const isAdmin = !!req.body?.isAdmin;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters.` });
    try {
      const user = users.createUser({ username, email, password, isAdmin });
      res.status(201).json({ ok: true, user });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  // Admin reset of another user's password.
  r.post('/users/:id/password', requireAuth(users), requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!users.getUser(id)) return res.status(404).json({ error: 'User not found.' });
    const password = String(req.body?.password ?? '');
    if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters.` });
    users.setPassword(id, password);
    users.deleteUserSessions(id); // force re-login with the new password
    res.json({ ok: true });
  });

  r.patch('/users/:id', requireAuth(users), requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!users.getUser(id)) return res.status(404).json({ error: 'User not found.' });
    // Guard against demoting the last admin into an admin-less instance.
    if (req.body?.isAdmin === false && users.getUser(id).isAdmin && users.countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last admin.' });
    }
    const patch = {};
    if (req.body?.email !== undefined) patch.email = req.body.email ? String(req.body.email).trim() : null;
    if (req.body?.isAdmin !== undefined) patch.isAdmin = !!req.body.isAdmin;
    res.json({ ok: true, user: users.updateUser(id, patch) });
  });

  r.delete('/users/:id', requireAuth(users), requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const target = users.getUser(id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    if (target.isAdmin && users.countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin.' });
    }
    users.deleteUser(id);
    res.json({ ok: true });
  });

  return r;
}

export { COOKIE };
