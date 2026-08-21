import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { log, errorFields } from './logger.js';
import { securityHeaders, renderHtml, rateLimiter, sameOriginOnly, safeEqual } from './security.js';
import * as db from './db.js';
import { checkLogin, setSessionCookie, clearSessionCookie, requireAuth } from './auth.js';
import { handleUpdate, registerWebhook } from './telegram.js';
import { startDigestScheduler, stopDigestScheduler } from './digest.js';
import { seedFromFile } from '../scripts/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

// Read the two pages once. They need a per-response CSP nonce injected, so they are
// served through renderHtml rather than sendFile.
const PAGES = {
  index: fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'),
  login: fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8'),
};

const app = express();
app.disable('x-powered-by');

// Behind Caddy, req.ip and req.secure are only meaningful if Express knows exactly how
// many proxies to trust. See config.trustProxy for why the number must be exact.
app.set('trust proxy', config.trustProxy);

app.use(securityHeaders);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(sameOriginOnly);

/* ---------------------------------------------------------------- health check */

// Before auth and before the rate limiter: systemd and Caddy poll this, and a health
// check that can be rate-limited into failure will eventually restart a healthy app.
// It reports liveness only - no version, no uptime, no database detail. The old
// /healthz answered before the database was reachable, so a broken deploy looked fine.
app.get('/healthz', async (_req, res) => {
  try {
    await db.ping();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

/* ------------------------------------------------------------------ auth pages */

const loginLimiter = rateLimiter({
  name: 'login',
  windowMs: config.rateLimit.loginWindowMs,
  max: config.rateLimit.loginMaxAttempts,
});

app.get('/login', renderHtml(PAGES.login));

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  try {
    if (await checkLogin(username, password)) {
      setSessionCookie(res, config.auth.username);
      log.security('login_success', { ip: req.ip });
      return res.json({ ok: true });
    }
    log.security('login_failed', { ip: req.ip });
    // One message for both wrong-username and wrong-password. Two distinct messages
    // would confirm which usernames exist.
    return res.status(401).json({ error: 'Wrong username or password.' });
  } catch (err) {
    // This used to return e.message to the client, handing the browser whatever the
    // bcrypt or config layer happened to throw.
    log.error('login error', errorFields(err));
    return res.status(500).json({ error: 'Sign in is unavailable.' });
  }
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  log.info('logout', { ip: req.ip });
  res.json({ ok: true });
});

/* ------------------------------------------------- telegram webhook (public) */

app.post('/telegram/webhook', (req, res) => {
  // config.js guarantees webhookSecret is non-empty whenever a bot token is set, so
  // this can no longer degenerate into `undefined !== undefined` and admit everyone.
  const presented = req.get('x-telegram-bot-api-secret-token');
  if (!config.telegram.webhookSecret || !safeEqual(presented ?? '', config.telegram.webhookSecret)) {
    log.security('webhook_rejected', { ip: req.ip });
    return res.sendStatus(401);
  }
  res.sendStatus(200);   // ack immediately; Telegram retries anything slower than 60s
  handleUpdate(req.body).catch(err => log.error('telegram update failed', errorFields(err)));
});

/* --------------------------------------------------- protected data + app */

const apiLimiter = rateLimiter({
  name: 'api',
  windowMs: config.rateLimit.apiWindowMs,
  max: config.rateLimit.apiMaxRequests,
});

// Errors thrown by a route are either a client mistake or a server fault, and the two
// must not be reported the same way. Anything deliberately thrown by db.js carries a
// message meant for the user; anything else (a pg error, a TypeError) is a bug whose
// text can name tables, columns and connection strings, so the client gets a generic
// sentence and the detail goes to the journal.
class ClientError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.expose = true; }
}

const SAFE_MESSAGES = new Set([
  'not found', 'unknown type', 'nothing to update', 'nothing to undo',
]);

const isSafe = err => err instanceof ClientError
  || SAFE_MESSAGES.has(err?.message)
  || /^(no valid sets|unknown type|unknown entry)/i.test(err?.message ?? '');

const api = fn => async (req, res) => {
  try {
    const out = await fn(req);
    if (out == null) return res.status(404).json({ error: 'Not found.' });
    res.json(out);
  } catch (err) {
    if (isSafe(err)) return res.status(err.status ?? 400).json({ error: err.message });
    log.error('api error', { path: req.path, ...errorFields(err) });
    res.status(500).json({ error: 'Something went wrong.' });
  }
};

app.use('/api', requireAuth, apiLimiter);

app.get('/api/data',   api(req => db.assembleData({ from: req.query.from, to: req.query.to })));
app.get('/api/stats',  api(() => db.getStatistics()));
app.get('/api/volume', api(req => db.getVolume({ from: req.query.from, to: req.query.to })));
app.get('/api/weekly', api(() => db.getWeeklySummary()));

// getExerciseSeries/suggestNext report a miss as { found:false, reason } so the AI can
// act on it; over HTTP that is still a 404.
const orNull = v => (v?.found === false ? null : v);

app.get('/api/exercise/:key', api(async req => orNull(await db.getExerciseSeries(req.params.key))));
app.get('/api/suggest/:key',  api(async req => orNull(await db.suggestNext(req.params.key))));
app.get('/api/rides',  api(req => db.getRideSeries({ location: req.query.location })));
app.get('/api/recent', api(req => db.getRecentActivity({
  days: req.query.days ? +req.query.days : undefined,
  limit: req.query.limit ? +req.query.limit : undefined,
})));

/* ------------------------------------------- write API (dashboard form) */

const ADD = { strength: db.addStrength, ride: db.addRide, bodyweight: db.addBodyweight };

app.post('/api/entry', api(req => {
  const { type, ...fields } = req.body || {};
  const add = ADD[type];
  if (!add) throw new ClientError(`unknown type ${type}`);
  return add(fields);
}));

app.patch('/api/entry/:type/:id', api(req =>
  db.updateEntry({ type: req.params.type, id: req.params.id, fields: req.body || {} })));

app.delete('/api/entry/:type/:id', api(req =>
  db.deleteEntry({ type: req.params.type, id: req.params.id })));

app.post('/api/undo', api(() => db.undoLast()));

/* ------------------------------------------------------------------ the app */

app.get('/', requireAuth, renderHtml(PAGES.index));

// Static assets. index.html and login.html are excluded because they must go through
// renderHtml to receive a CSP nonce - served raw from here their inline scripts would
// be blocked by the policy. maxAge is 0: this is a private dashboard, and a shared
// cache holding one user's page is not a trade worth making.
app.use(requireAuth, express.static(PUBLIC, {
  index: false,
  dotfiles: 'deny',
  maxAge: 0,
  setHeaders: res => res.setHeader('Cache-Control', 'no-store'),
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).type('text/plain').send('Not found');
});

// Express's default error handler prints the stack trace into the response body.
// eslint-disable-next-line no-unused-vars -- Express identifies this by arity; all four are required.
app.use((err, req, res, _next) => {
  log.error('unhandled request error', { path: req.path, ...errorFields(err) });
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong.' });
});

/* ----------------------------------------------------------------------- boot */

let server;

async function start() {
  await db.initSchema();

  if (config.seedOnEmpty && await db.isEmpty()) {
    const n = await seedFromFile(path.join(__dirname, '..', 'gym.json')).catch(() => 0);
    if (n) log.info('seeded from gym.json', { entries: n });
  }

  await db.pruneChatHistory(config.telegram.historyRetentionDays).catch(
    err => log.warn('chat history prune failed', errorFields(err)));

  await new Promise((resolve, reject) => {
    server = app.listen(config.port, config.host, resolve);
    server.on('error', reject);
  });

  // Slowloris: a client that opens a connection and dribbles bytes holds a socket open
  // indefinitely under Node's defaults. Caddy fronts this, but the app should not
  // depend on the proxy for its own liveness.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;   // > Caddy's default idle timeout, so the proxy closes first

  log.info('listening', { host: config.host, port: config.port, env: config.nodeEnv });

  if (config.publicUrl && config.telegram.botToken) {
    try {
      const url = await registerWebhook(config.publicUrl, config.telegram.webhookSecret);
      log.info('telegram webhook registered', { url });
    } catch (err) {
      // Not fatal: the dashboard is still worth serving if only the bot is broken.
      log.error('telegram webhook registration failed', errorFields(err));
    }
  } else {
    log.info('telegram webhook not registered (no PUBLIC_URL or bot token)');
  }

  startDigestScheduler();   // self-disables unless DIGEST_ENABLED=true
}

/* ------------------------------------------------------------------ shutdown */

// systemd sends SIGTERM on `systemctl restart` and waits. Without this the process is
// killed mid-request and mid-transaction; with it, in-flight work finishes first.
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });

  const forced = setTimeout(() => {
    log.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forced.unref();

  try {
    stopDigestScheduler();
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close();
    log.info('shutdown complete');
    clearTimeout(forced);
    process.exit(0);
  } catch (err) {
    log.error('error during shutdown', errorFields(err));
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A rejection nobody handled leaves the process in an unknown state. Log it and let
// systemd restart cleanly rather than continuing on corrupt assumptions.
process.on('unhandledRejection', err => {
  log.error('unhandled rejection', errorFields(err));
  shutdown('unhandledRejection');
});
process.on('uncaughtException', err => {
  log.error('uncaught exception', errorFields(err));
  shutdown('uncaughtException');
});

start().catch(err => {
  log.error('failed to start', errorFields(err));
  process.exit(1);
});
