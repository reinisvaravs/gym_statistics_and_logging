// Security middleware, hand-written rather than pulled from helmet + express-rate-limit.
//
// Both libraries are good. They are not used here because this app needs perhaps sixty
// lines of what they do, and a single-user side project on a box shared with every other
// side project is better served by two dependencies it can read end to end than by two
// more supply-chain surfaces to keep patched. The behaviour below matches helmet's
// defaults where it overlaps.

import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './logger.js';

/* -------------------------------------------------------------- constant time */

// `a !== b` on a secret leaks, through timing, how many leading characters were right.
// timingSafeEqual needs equal-length buffers, so both sides are hashed first - that
// makes the comparison fixed-width without revealing the length of the real secret.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------------------------------------------------------------- CSP + headers */

// The dashboard has no external assets at all: no CDN, no webfont, no analytics. Every
// script and style is inline in the two HTML files, and every fetch is a same-origin
// relative path. That means the policy can be as tight as a policy gets - the only
// concession is that inline <script>/<style> need a per-response nonce, injected by
// renderHtml() below. `'unsafe-inline'` is deliberately absent.
function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",   // clickjacking; supersedes X-Frame-Options
    "base-uri 'none'",          // stops an injected <base> retargeting relative URLs
    "object-src 'none'",
    ...(config.isProd ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function securityHeaders(req, res, next) {
  // One nonce per response, from a CSPRNG. Reusing a nonce across responses would make
  // it guessable and defeat the point.
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');

  res.setHeader('Content-Security-Policy', contentSecurityPolicy(res.locals.cspNonce));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
  res.setHeader('Origin-Agent-Cluster', '?1');

  // Express advertises itself by default. Free reconnaissance for no benefit.
  res.removeHeader('X-Powered-By');

  // HSTS only over a genuinely secure connection. Sending it over plain HTTP during
  // local development would pin localhost to https:// in the browser for two years.
  if (config.isProd && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  next();
}

// Serve an HTML file with the CSP nonce injected. The two files carry bare <script> and
// <style> tags; this rewrites them to <script nonce="...">. Files are read once at boot,
// so this costs one string replace per request and nothing else.
export function renderHtml(html) {
  return (req, res) => {
    const nonce = res.locals.cspNonce;
    res.type('html').send(
      html.replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${nonce}"`)
    );
  };
}

/* ------------------------------------------------------------------ rate limit */

// Fixed-window counter in memory. Correct here because the app is one process on one
// box; a multi-process deployment would need a shared store, and this comment is the
// reminder of why. Entries are swept lazily so an idle process holds nothing.
export function rateLimiter({ windowMs, max, name }) {
  const hits = new Map();   // key -> { count, resetAt }

  const sweep = now => {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  };

  return function rateLimit(req, res, next) {
    const now = Date.now();
    // Sweep occasionally rather than every request; an unbounded Map is a slow leak.
    if (hits.size > 1000) sweep(now);

    // req.ip is only trustworthy because config.trustProxy is set to the exact number
    // of proxies in front. Get that wrong and a client can pick its own bucket.
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      // Logged once per window, not once per request: a flood must not become a
      // second denial of service against the disk.
      if (entry.count === max + 1) {
        log.security('rate_limited', { limiter: name, ip: key, path: req.path });
      }
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    next();
  };
}

/* ------------------------------------------------------------------------ CSRF */

// The session cookie is SameSite=Strict, which already stops a browser attaching it to
// any cross-site request. This is the second layer, for the case where that guarantee
// does not hold - an old browser, or a future relaxation of the cookie policy.
//
// Only unsafe methods are checked. A request with no Origin at all is allowed because
// same-origin GETs and some non-browser clients omit it; a request with a *wrong*
// Origin is always rejected.
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function sameOriginOnly(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();

  const origin = req.get('origin');
  if (!origin) return next();

  const expected = config.publicUrl
    || `${req.protocol}://${req.get('host') ?? ''}`;

  let a, b;
  try { a = new URL(origin); b = new URL(expected); }
  catch { return next(); }

  if (a.host !== b.host || a.protocol !== b.protocol) {
    log.security('cross_origin_rejected', { ip: req.ip, path: req.path, origin });
    return res.status(403).json({ error: 'Cross-origin request rejected.' });
  }
  next();
}
