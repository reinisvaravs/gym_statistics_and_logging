// Structured logging. One JSON object per line on stdout, which is exactly what
// journald stores and what `journalctl -u gym-tracker -o cat | jq` reads back.
//
// Two rules drive the design:
//   1. A log line must never contain a secret. This process holds a Postgres password,
//      an OpenAI key, a Telegram bot token and the session-signing secret; any of them
//      could reach a log through an error message or a thrown request body. Everything
//      is scrubbed on the way out rather than trusting each call site to remember.
//   2. Security-relevant events get a stable `event` name, so fail2ban and journalctl
//      can match on them without parsing prose that might get reworded later.

import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

// Long, high-entropy values worth scrubbing wherever they appear in a string.
const secrets = [
  config.auth.sessionSecret,
  config.telegram.botToken,
  config.telegram.webhookSecret,
  config.openai.apiKey,
  config.strava.clientSecret,
  config.strava.refreshToken,
  config.auth.passwordHash,
].filter(s => typeof s === 'string' && s.length >= 8);

// Also catch secrets that never went through config - a Postgres URL embedded in a pg
// error, or a bearer token echoed by an upstream API.
const PATTERNS = [
  [/\b(postgres(?:ql)?:\/\/)[^\s"']*/gi, '$1[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted-openai-key]'],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, '[redacted-bot-token]'],
  [/\b(authorization|bearer)\s+\S+/gi, '$1 [redacted]'],
];

export function redact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) {
      if (out.includes(s)) out = out.split(s).join('[redacted]');
    }
    for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /pass|secret|token|key|authorization|cookie/i.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

function emit(level, message, fields = {}) {
  if ((LEVELS[level] ?? LEVELS.info) > threshold) return;
  const line = { level, msg: redact(String(message)), ...redact(fields) };
  // Never let logging itself take the process down - a circular reference in a field
  // must not turn a handled error into a crash loop.
  let text;
  try { text = JSON.stringify(line); }
  catch { text = JSON.stringify({ level, msg: redact(String(message)), note: 'fields were not serialisable' }); }
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(text + '\n');
}

export const log = {
  error: (msg, fields) => emit('error', msg, fields),
  warn:  (msg, fields) => emit('warn', msg, fields),
  info:  (msg, fields) => emit('info', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),

  // Security events carry a stable `event` key. These are the lines worth alerting on.
  security: (event, fields = {}) => emit('warn', `security.${event}`, { event, ...fields }),
};

// An Error is not JSON-serialisable - `JSON.stringify(new Error('x'))` is `{}`, which is
// how a stack trace silently becomes an empty object in the log.
export const errorFields = err => ({
  err: redact(err?.message ?? String(err)),
  stack: config.isProd ? undefined : redact(err?.stack ?? ''),
  code: err?.code,
});

export default log;
