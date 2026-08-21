// Single-user session auth: a bcrypt password check, then an HMAC-signed cookie.
//
// The signing secret now comes from config.js, which refuses to boot without a real one.
// It used to be `process.env.SESSION_SECRET || 'dev-insecure-secret'` - a missing variable
// produced a server that worked perfectly and whose cookies anyone could forge.

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { log } from './logger.js';
import { safeEqual } from './security.js';

const { username: USER, passwordHash: HASH, sessionSecret: SECRET, sessionMaxAgeMs: MAX_AGE } = config.auth;

const COOKIE = 'session';

// A bcrypt hash of a value nobody knows. checkLogin compares against this when the
// username is wrong, so a wrong username costs the same ~100ms as a wrong password and
// the response time stops revealing which of the two was incorrect.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);

const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    exp: Date.now() + MAX_AGE,
    // Random per session, so two logins never mint the same token and a leaked cookie
    // can be told apart from a re-issued one in the logs.
    jti: crypto.randomBytes(8).toString('base64url'),
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Constant-time. `sign(payload) !== sig` leaks, through response timing, how many
  // leading bytes of a forged signature were correct - enough to forge one byte at a
  // time given sufficient attempts.
  if (!safeEqual(sign(payload), sig)) return null;

  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!exp || typeof exp !== 'number' || Date.now() > exp) return null;
    // A cookie signed for a different username than the one now configured must not be
    // honoured - changing AUTH_USERNAME should invalidate old sessions.
    if (u !== USER) return null;
    return u;
  } catch { return null; }
}

// Verify credentials against the single configured user. Always runs one bcrypt compare.
export async function checkLogin(username, password) {
  const pw = typeof password === 'string' ? password : '';
  const match = username === USER;
  const ok = await bcrypt.compare(pw, match ? HASH : DUMMY_HASH);
  return match && ok;
}

export function setSessionCookie(res, username) {
  res.cookie(COOKIE, makeToken(username), {
    httpOnly: true,        // unreadable from JavaScript, so an XSS cannot steal it
    sameSite: 'strict',    // was 'lax'; strict blocks the cookie on every cross-site request
    secure: config.isProd, // HTTPS only in production
    maxAge: MAX_AGE,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  // The clearing cookie must carry the same attributes as the one it replaces, or the
  // browser treats it as a different cookie and the original survives the logout.
  res.clearCookie(COOKIE, {
    httpOnly: true, sameSite: 'strict', secure: config.isProd, path: '/',
  });
}

// 401s API calls, redirects page loads to /login.
export function requireAuth(req, res, next) {
  const user = verifyToken(req.cookies?.[COOKIE]);
  if (user) { req.user = user; return next(); }

  // A cookie that was sent but did not verify is either expired or forged. Worth a line;
  // a request with no cookie at all is just a signed-out visitor and is not.
  if (req.cookies?.[COOKIE]) {
    log.security('invalid_session', { ip: req.ip, path: req.originalUrl });
  }

  // originalUrl, not path: this middleware is mounted at /api, and inside a mount
  // req.path is relative to it ('/data', not '/api/data'). Using req.path here sent a
  // 302 to /login for API calls, and the dashboard's fetch wrapper - which keys its
  // "signed out" handling off a 401 - followed the redirect and tried to parse the
  // login page as JSON.
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login');
}
