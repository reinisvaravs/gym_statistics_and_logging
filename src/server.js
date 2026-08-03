import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './db.js';
import { checkLogin, setSessionCookie, clearSessionCookie, requireAuth } from './auth.js';
import { handleUpdate, registerWebhook } from './telegram.js';
import { startDigestScheduler } from './digest.js';
import { seedFromFile } from '../scripts/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 8731;

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

/* --------------------------------------------------------------- auth pages */

app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC, 'login.html')));

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (await checkLogin(username, password)) { setSessionCookie(res, username); return res.json({ ok: true }); }
    res.status(401).json({ error: 'Wrong username or password.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

/* --------------------------------------------------- telegram webhook (public) */

app.post('/telegram/webhook', (req, res) => {
  if (req.get('x-telegram-bot-api-secret-token') !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);                                   // ack immediately
  handleUpdate(req.body).catch(err => console.error('update error:', err.message));
});

/* ----------------------------------------------------- protected data + app */

// Wrap a handler so every route reports errors the same way.
const api = fn => async (req, res) => {
  try {
    const out = await fn(req);
    if (out == null) return res.status(404).json({ error: 'not found' });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
};

app.get('/api/data',  requireAuth, api(req => db.assembleData({ from: req.query.from, to: req.query.to })));
app.get('/api/stats', requireAuth, api(() => db.getStatistics()));
app.get('/api/volume', requireAuth, api(req => db.getVolume({ from: req.query.from, to: req.query.to })));
app.get('/api/weekly', requireAuth, api(() => db.getWeeklySummary()));
// getExerciseSeries/suggestNext now report a miss as { found:false, reason } so the AI can
// act on it; over HTTP that is still a 404.
const orNull = v => (v?.found === false ? null : v);

app.get('/api/exercise/:key', requireAuth, api(async req => orNull(await db.getExerciseSeries(req.params.key))));
app.get('/api/suggest/:key', requireAuth, api(async req => orNull(await db.suggestNext(req.params.key))));
app.get('/api/rides', requireAuth, api(req => db.getRideSeries({ location: req.query.location })));
app.get('/api/recent', requireAuth, api(req => db.getRecentActivity({
  days: req.query.days ? +req.query.days : undefined,
  limit: req.query.limit ? +req.query.limit : undefined,
})));

/* ------------------------------------------------- write API (dashboard form) */

const ADD = { strength: db.addStrength, ride: db.addRide, bodyweight: db.addBodyweight };

app.post('/api/entry', requireAuth, api(req => {
  const { type, ...fields } = req.body || {};
  const add = ADD[type];
  if (!add) throw new Error(`unknown type ${type}`);
  return add(fields);
}));

app.patch('/api/entry/:type/:id', requireAuth, api(req =>
  db.updateEntry({ type: req.params.type, id: req.params.id, fields: req.body || {} })));

app.delete('/api/entry/:type/:id', requireAuth, api(req =>
  db.deleteEntry({ type: req.params.type, id: req.params.id })));

app.post('/api/undo', requireAuth, api(() => db.undoLast()));

app.get('/', requireAuth, (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// static assets (css/js live inside the html, but serve the folder for anything else)
app.use(requireAuth, express.static(PUBLIC));

/* --------------------------------------------------------------------- boot */

async function start() {
  await db.initSchema();
  if (await db.isEmpty()) {
    const n = await seedFromFile(path.join(__dirname, '..', 'gym.json')).catch(() => 0);
    if (n) console.log(`Seeded ${n} entries from gym.json`);
  }
  const publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  app.listen(PORT, async () => {
    console.log(`Gym tracker on :${PORT}`);
    if (publicUrl && process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const url = await registerWebhook(publicUrl, process.env.TELEGRAM_WEBHOOK_SECRET);
        console.log(`Telegram webhook set → ${url}`);
      } catch (e) { console.error('Webhook registration failed:', e.message); }
    } else {
      console.log('No public URL or bot token — webhook not registered (fine for local dev).');
    }
    startDigestScheduler();   // self-disables unless DIGEST_ENABLED=true
  });
}

start().catch(err => { console.error('Fatal:', err); process.exit(1); });
