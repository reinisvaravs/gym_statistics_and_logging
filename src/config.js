// Every environment variable is read here and nowhere else, and every one of them is
// validated at boot.
//
// This module exists because of two real bugs. `SESSION_SECRET || 'dev-insecure-secret'`
// meant a missing variable produced a *working* server whose session cookies anyone could
// forge. `req.get(header) !== process.env.TELEGRAM_WEBHOOK_SECRET` meant an unset secret
// compared undefined to undefined, and the webhook authenticated the whole internet.
//
// Both failures look identical to a healthy boot. So: no silent fallbacks for anything
// that carries security weight. A misconfigured server refuses to start and says why.

import crypto from 'node:crypto';

const env = process.env;
const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const problems = [];
const fail = msg => problems.push(msg);

/* ------------------------------------------------------------------ helpers */

function required(name, { minLength = 0, hint = '' } = {}) {
  const raw = (env[name] ?? '').trim();
  if (!raw) {
    fail(`${name} is not set.${hint ? ` ${hint}` : ''}`);
    return '';
  }
  if (minLength && raw.length < minLength) {
    fail(`${name} is only ${raw.length} characters; at least ${minLength} are required.${hint ? ` ${hint}` : ''}`);
  }
  return raw;
}

// Optional in development, mandatory in production. Dev gets a random value so the
// process still runs - random, never a constant, so a dev secret can never become a
// production one by accident, and restarting invalidates old cookies.
function requiredInProd(name, { minLength = 0, hint = '' } = {}) {
  const raw = (env[name] ?? '').trim();
  if (raw) {
    if (minLength && raw.length < minLength) {
      fail(`${name} is only ${raw.length} characters; at least ${minLength} are required.${hint ? ` ${hint}` : ''}`);
    }
    return raw;
  }
  if (isProd) {
    fail(`${name} is not set, and it is mandatory when NODE_ENV=production.${hint ? ` ${hint}` : ''}`);
    return '';
  }
  return crypto.randomBytes(32).toString('hex');
}

function integer(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail(`${name} must be a whole number between ${min} and ${max}; got ${JSON.stringify(raw)}.`);
    return fallback;
  }
  return n;
}

// Exactly "true" or "false". A typo like DIGEST_ENABLED=yes previously read as "off"
// in silence, which is how a feature ends up mysteriously never running.
function boolean(name, fallback) {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be exactly "true" or "false"; got ${JSON.stringify(env[name])}.`);
  return fallback;
}

function timezone(name, fallback) {
  const raw = (env[name] ?? '').trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: raw });
    return raw;
  } catch {
    fail(`${name}=${JSON.stringify(raw)} is not a valid IANA timezone (e.g. Europe/Riga).`);
    return fallback;
  }
}

/* -------------------------------------------------------------------- values */

const port = integer('PORT', 8731, { min: 1, max: 65535 });

// Bind to loopback by default. The previous code called app.listen(PORT) with no host,
// which binds 0.0.0.0 - on a VPS that publishes the app straight to the internet on a
// port the reverse proxy never sees and ufw may not be covering. Public traffic must
// arrive through Caddy, which terminates TLS and is the only thing facing the network.
const host = (env.HOST ?? '').trim() || '127.0.0.1';

const databaseUrl = required('DATABASE_URL', { hint: 'Postgres connection string.' });

// Verifying the server certificate is the entire point of TLS. The old config set
// rejectUnauthorized:false unconditionally, which accepts any certificate at all and
// leaves the connection open to interception.
//
// Whether TLS applies at all is derived from the connection host rather than asked for
// in a separate variable: a loopback connection never leaves the machine and Postgres
// is not configured for TLS there, while anything remote must present a certificate
// that actually validates. One less variable to set, and no way to accidentally
// disable verification on a remote database by copying a local .env.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '']);

const databaseSsl = (() => {
  let host = '';
  try { host = new URL(databaseUrl).hostname; } catch { /* validated below */ }
  if (LOOPBACK.has(host)) return false;
  const ca = (env.DATABASE_CA_CERT ?? '').trim();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
})();

const auth = {
  username: required('AUTH_USERNAME'),
  passwordHash: required('AUTH_PASSWORD_HASH', {
    hint: 'Generate it with: node scripts/hash-password.js "your password"',
  }),
  // 64 hex characters = 32 bytes of entropy. Anything shorter is guessable offline, and
  // guessing it means minting a valid session cookie without knowing the password.
  sessionSecret: requiredInProd('SESSION_SECRET', {
    minLength: 32,
    hint: 'Generate it with: openssl rand -hex 32',
  }),
  sessionMaxAgeMs: integer('SESSION_MAX_AGE_DAYS', 30, { min: 1, max: 365 }) * 24 * 3600 * 1000,
};

if (auth.passwordHash && !/^\$2[aby]\$\d{2}\$/.test(auth.passwordHash)) {
  fail('AUTH_PASSWORD_HASH is not a bcrypt hash. It must start with $2a$, $2b$ or $2y$ - ' +
       'you may have pasted the password itself instead of the hash.');
}

const telegram = {
  botToken: (env.TELEGRAM_BOT_TOKEN ?? '').trim(),
  webhookSecret: (env.TELEGRAM_WEBHOOK_SECRET ?? '').trim(),
  allowedUserId: (env.ALLOWED_TELEGRAM_USER_ID ?? '').trim(),
  historyTurns: integer('CHAT_HISTORY_TURNS', 20, { min: 0, max: 100 }),
  // Rolling history is a conversational convenience, not a record. Without a ceiling
  // chat_messages grows forever on a 38 GB disk shared with every other side project.
  historyRetentionDays: integer('CHAT_HISTORY_RETENTION_DAYS', 90, { min: 1, max: 3650 }),
};

// The bot is only reachable over the webhook, and the webhook's only defence is this
// shared secret. A bot token with no secret is strictly worse than no bot at all.
if (telegram.botToken && !telegram.webhookSecret) {
  fail('TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_SECRET is not. The webhook would ' +
       'accept unauthenticated requests. Generate one with: openssl rand -hex 32');
}
if (telegram.webhookSecret && telegram.webhookSecret.length < 16) {
  fail(`TELEGRAM_WEBHOOK_SECRET is only ${telegram.webhookSecret.length} characters; at least 16 are required.`);
}
if (telegram.allowedUserId && !/^\d+$/.test(telegram.allowedUserId)) {
  fail('ALLOWED_TELEGRAM_USER_ID must be a numeric Telegram user id.');
}
// Empty allowlist makes the bot answer any stranger with its bootstrap "your id is N"
// reply. That is a deliberate first-run convenience and a hole in production.
if (isProd && telegram.botToken && !telegram.allowedUserId) {
  fail('ALLOWED_TELEGRAM_USER_ID is empty while NODE_ENV=production. The bot would respond ' +
       'to anyone who messages it. Set it to your numeric Telegram user id.');
}

const openai = {
  apiKey: (env.OPENAI_API_KEY ?? '').trim(),
  model: (env.OPENAI_MODEL ?? '').trim() || 'gpt-4o-mini',
  visionModel: (env.OPENAI_VISION_MODEL ?? '').trim() || 'gpt-4o-mini',
  transcribeModel: (env.OPENAI_TRANSCRIBE_MODEL ?? '').trim() || 'whisper-1',
};
if (telegram.botToken && !openai.apiKey) {
  fail('TELEGRAM_BOT_TOKEN is set but OPENAI_API_KEY is not - the bot cannot parse any message.');
}

// publicUrl must be HTTPS: Telegram refuses a plaintext webhook, and the session cookie
// is Secure-only, so a http:// origin would silently never authenticate.
const publicUrl = (() => {
  const raw = (env.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) {
    if (isProd && telegram.botToken) {
      fail('PUBLIC_URL is not set. The Telegram webhook cannot be registered without it.');
    }
    return '';
  }
  let url;
  try { url = new URL(raw); } catch { fail(`PUBLIC_URL=${JSON.stringify(raw)} is not a valid URL.`); return ''; }
  if (url.protocol !== 'https:') fail('PUBLIC_URL must use https:// - Telegram rejects plaintext webhooks.');
  return raw;
})();

const digest = {
  enabled: boolean('DIGEST_ENABLED', false),
  hour: integer('DIGEST_HOUR', 19, { min: 0, max: 23 }),
  weeklyDay: integer('DIGEST_WEEKLY_DAY', 0, { min: 0, max: 6 }),
};
if (digest.enabled && !telegram.botToken) {
  fail('DIGEST_ENABLED=true but TELEGRAM_BOT_TOKEN is not set - there is nowhere to send the digest.');
}

const strava = {
  clientId: (env.STRAVA_CLIENT_ID ?? '').trim(),
  clientSecret: (env.STRAVA_CLIENT_SECRET ?? '').trim(),
  refreshToken: (env.STRAVA_REFRESH_TOKEN ?? '').trim(),
};

const rateLimit = {
  // Deliberately tight: one human logging in from one browser. Anything above this on a
  // single-user dashboard is a password-guessing attempt, not a person who forgot.
  loginMaxAttempts: integer('RATE_LIMIT_LOGIN_ATTEMPTS', 8, { min: 1, max: 1000 }),
  loginWindowMs: integer('RATE_LIMIT_LOGIN_WINDOW_MINUTES', 15, { min: 1, max: 1440 }) * 60_000,
  apiMaxRequests: integer('RATE_LIMIT_API_REQUESTS', 600, { min: 10, max: 100_000 }),
  apiWindowMs: integer('RATE_LIMIT_API_WINDOW_MINUTES', 5, { min: 1, max: 1440 }) * 60_000,
};

// How many proxies sit in front. Behind Caddy on the same host that is exactly 1.
// This value decides which entry of X-Forwarded-For Express believes, so it must be
// exact: too high and a client can spoof its own IP by sending the header itself,
// which would poison both rate limiting and the logs fail2ban reads.
const trustProxy = integer('TRUST_PROXY_HOPS', isProd ? 1 : 0, { min: 0, max: 10 });

// Reading gym.json off disk and writing it into the database is a first-run convenience.
// On a server it is a foot-gun: an empty database after a failed restore would silently
// refill with stale data and mask the real problem.
const seedOnEmpty = boolean('SEED_ON_EMPTY', !isProd);

const tz = timezone('TIMEZONE', 'Europe/Riga');

/* ------------------------------------------------------------------- verdict */

if (problems.length) {
  const lines = problems.map(p => `  - ${p}`).join('\n');
  throw new Error(
    `Refusing to start: ${problems.length} configuration problem(s).\n${lines}\n\n` +
    `Every variable is documented in .env.example.`
  );
}

export const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isProd,
  port,
  host,
  publicUrl,
  trustProxy,
  seedOnEmpty,
  timezone: tz,
  logLevel: (env.LOG_LEVEL ?? '').trim() || (isProd ? 'info' : 'debug'),
  database: Object.freeze({ url: databaseUrl, ssl: databaseSsl }),
  auth: Object.freeze(auth),
  telegram: Object.freeze(telegram),
  openai: Object.freeze(openai),
  digest: Object.freeze(digest),
  strava: Object.freeze(strava),
  rateLimit: Object.freeze(rateLimit),
});

export default config;
