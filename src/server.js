import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as db from './db.js';
import { checkLogin, setSessionCookie, clearSessionCookie, requireAuth } from './auth.js';
import { handleUpdate, registerWebhook } from './telegram.js';
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

app.get('/api/data', requireAuth, async (_req, res) => {
  try { res.json(await db.assembleData()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', requireAuth, async (_req, res) => {
  try { res.json(await db.getStatistics()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

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
  });
}

start().catch(err => { console.error('Fatal:', err); process.exit(1); });
