import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret';
const USER   = process.env.AUTH_USERNAME || '';
const HASH   = process.env.AUTH_PASSWORD_HASH || '';
const MAX_AGE = 30 * 24 * 3600 * 1000;   // 30 days

const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + MAX_AGE })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (sign(payload) !== sig) return null;                          // tampered
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!exp || Date.now() > exp) return null;                      // expired
    return u;
  } catch { return null; }
}

// verify credentials against the single configured user
export async function checkLogin(username, password) {
  if (!USER || !HASH) throw new Error('Auth is not configured (AUTH_USERNAME / AUTH_PASSWORD_HASH).');
  if (username !== USER) return false;
  return bcrypt.compare(password || '', HASH);
}

export function setSessionCookie(res, username) {
  res.cookie('session', makeToken(username), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE, path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie('session', { path: '/' });
}

// Express middleware — 401s API calls, redirects page loads to /login.
export function requireAuth(req, res, next) {
  const user = verifyToken(req.cookies?.session);
  if (user) { req.user = user; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}
