// The bot otherwise only ever speaks when spoken to. This pushes: a weekly recap,
// staleness nudges for lifts that have fallen out of rotation, and a next-session
// suggestion. Every message is plain text — the project never sends parse_mode.

import * as db from './db.js';
import { sendMessage } from './telegram.js';
import { today, daysBetween, timezone } from './time.js';
import { config } from './config.js';
import { log, errorFields } from './logger.js';

const round = (v, n = 0) => Math.round(+v * 10 ** n) / 10 ** n;

// Tonnage reads better in tonnes once it gets big; kg below that.
const tonnage = kg => (kg >= 1000 ? `${round(kg / 1000, 1)}t` : `${round(kg)}kg`);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "+12% on last week" — omitted entirely when there is no baseline to compare against.
function delta(now, before) {
  if (!before) return '';
  const pct = round(((now - before) / before) * 100);
  if (pct === 0) return ', level with last week';
  return `, ${pct > 0 ? '+' : ''}${pct}% on last week`;
}

/* ------------------------------------------------------------------- staleness */

// A lift is stale relative to its *own* rhythm: someone who benches every three weeks
// should not be nagged weekly. The floor stops twice-a-week lifts triggering after 4 days.
const STALE_FACTOR = 1.75;
const STALE_FLOOR_DAYS = 10;

// If nothing at all was logged recently the problem isn't any one lift, so we say nothing
// here and let the weekly recap carry that message.
const QUIET_DAYS = 14;

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Ranks every lift by how overdue it is (daysSince / its own threshold). getLastSessions
// only knows the last date, so the per-lift cadence comes from the full session history.
async function rankByStaleness(now) {
  const [last, data] = await Promise.all([db.getLastSessions(now), db.assembleData()]);

  const gapsByKey = new Map();
  for (const ex of data.strength) {
    const dates = [...new Set(ex.sessions.map(s => s.d))].sort();
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d)).filter(g => g > 0);
    gapsByKey.set(ex.key, gaps);
  }

  const ranked = last.strength.map(l => {
    const gaps = gapsByKey.get(l.key) || [];
    if (!gaps.length) return null;                 // one session ever — no rhythm to judge against
    const gap = median(gaps);
    const threshold = Math.max(STALE_FLOOR_DAYS, gap * STALE_FACTOR);
    return { ...l, medianGap: round(gap), threshold, overdue: l.daysSince / threshold };
  }).filter(Boolean).sort((a, b) => b.overdue - a.overdue);

  const freshest = Math.min(
    ...last.strength.map(l => l.daysSince),
    last.daysSinceRide ?? Infinity,
  );
  return { ranked, freshest, quiet: !Number.isFinite(freshest) || freshest > QUIET_DAYS };
}

// During a real layoff, per-lift nagging is noise — but silence is worse, because that is
// exactly when a nudge is worth having. Compromise: one line, once a week into the break.
export async function buildLayoff(now = today()) {
  const { freshest, quiet } = await rankByStaleness(now);
  if (!quiet || !Number.isFinite(freshest)) return null;
  if (freshest % 7 !== 0) return null;
  return `No training logged for ${freshest} days. Even one easy session gets the streak going again.`;
}

/* -------------------------------------------------------------------- messages */

// Short enough to read from a lock screen.
export async function buildWeeklyRecap(now = today()) {
  const { thisWeek, lastWeek, prs } = await db.getWeeklySummary(now);
  const lines = [`Week of ${thisWeek.from}`];

  if (!thisWeek.trainingDays) {
    lines.push('- nothing logged yet this week');
    if (lastWeek.trainingDays) lines.push(`- last week: ${plural(lastWeek.trainingDays, 'training day')}, ${tonnage(lastWeek.volumeKg)}`);
    return lines.join('\n');
  }

  lines.push(`- ${plural(thisWeek.trainingDays, 'training day')}, ${plural(thisWeek.strengthSessions, 'lifting session')}`);
  if (thisWeek.volumeKg) lines.push(`- ${tonnage(thisWeek.volumeKg)} lifted${delta(thisWeek.volumeKg, lastWeek.volumeKg)}`);
  if (thisWeek.rides) lines.push(`- ${plural(thisWeek.rides, 'ride')}${thisWeek.rideKm ? `, ${round(thisWeek.rideKm, 1)}km` : ''}`);
  for (const p of prs.slice(0, 3)) {
    lines.push(`- PR: ${p.exercise} ${p.e1rm}kg e1RM${p.previousBest ? ` (was ${p.previousBest})` : ' (first)'}`);
  }
  return lines.join('\n');
}

export async function buildNudges(now = today()) {
  const { ranked, quiet } = await rankByStaleness(now);
  if (quiet) return null;

  const stale = ranked.filter(l => l.daysSince > l.threshold).slice(0, 3);
  if (!stale.length) return null;

  return ['Getting stale:', ...stale.map(l =>
    `- ${l.exercise}: ${l.daysSince} days (usually every ${l.medianGap})`)].join('\n');
}

export async function buildNextSession(now = today()) {
  const { ranked } = await rankByStaleness(now);
  if (!ranked.length) return null;

  const picks = await Promise.all(ranked.slice(0, 3).map(l => db.suggestNext(l.key)));
  const lines = picks.filter(Boolean).map(p => `- ${p.suggestion}`);
  if (!lines.length) return null;
  return ['Next session:', ...lines].join('\n');
}

// kind:'weekly' is the Sunday recap; kind:'daily' is the quiet nudge that stays silent
// when there is genuinely nothing worth a notification.
export async function buildDigest(now = today(), { kind = 'weekly' } = {}) {
  const [nudges, layoff] = await Promise.all([buildNudges(now), buildLayoff(now)]);

  if (kind === 'daily') {
    if (!nudges && !layoff) return null;            // a daily job must not chatter
    const next = await buildNextSession(now);
    return [layoff, nudges, next].filter(Boolean).join('\n\n');
  }

  const [recap, next] = await Promise.all([buildWeeklyRecap(now), buildNextSession(now)]);
  return [recap, layoff, nudges, next].filter(Boolean).join('\n\n');
}

/* --------------------------------------------------------------------- sending */

// In a private chat the Telegram user id doubles as the chat id.
export async function sendDigest({ kind = 'weekly', now = today() } = {}) {
  const chatId = config.telegram.allowedUserId;
  if (!chatId) {
    log.warn('digest skipped: ALLOWED_TELEGRAM_USER_ID is unset');
    return { sent: false, text: null };
  }
  const text = await buildDigest(now, { kind });
  if (!text) {
    log.debug('digest: nothing to say', { kind });
    return { sent: false, text: null };
  }
  await sendMessage(chatId, text);
  return { sent: true, text };
}

/* ------------------------------------------------------------------- scheduler */

const CHECK_MS = 30 * 60 * 1000;

// Local wall-clock hour in the configured timezone. h23 so midnight is 0, not 24.
const localHour = (at = new Date()) =>
  +new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(at);

// Day of week for a YYYY-MM-DD string, 0 = Sunday (matches DIGEST_WEEKLY_DAY).
const dayOfWeek = date => new Date(`${date}T00:00:00Z`).getUTCDay();

// Held at module scope so shutdown() can clear it without threading a handle back
// through server.js. A timer left running keeps the event loop alive and turns a clean
// systemd restart into a 90-second wait for SIGKILL.
let digestTimer = null;

export function stopDigestScheduler() {
  if (digestTimer) { clearInterval(digestTimer); digestTimer = null; }
}

export function startDigestScheduler() {
  if (!config.digest.enabled) {
    log.info('digest disabled (set DIGEST_ENABLED=true to turn it on)');
    return { stop() {} };
  }
  const { hour, weeklyDay } = config.digest;

  // Last local date each kind went out. Lost on restart, which is why we also require the
  // clock to still be inside the send hour — worst case a redeploy resends once.
  let sentWeekly = null, sentDaily = null;

  async function tick() {
    const at = new Date();
    if (localHour(at) !== hour) return;
    const date = today(at);

    if (dayOfWeek(date) === weeklyDay) {
      if (sentWeekly === date) return;
      sentWeekly = sentDaily = date;               // claim before awaiting, and skip the nudge
      await sendDigest({ kind: 'weekly', now: date });
      return;
    }
    if (sentDaily === date) return;
    sentDaily = date;
    await sendDigest({ kind: 'daily', now: date });
  }

  // A transient DB or Telegram blip must never kill the timer.
  const safeTick = () => tick().catch(err => log.error('digest tick failed', errorFields(err)));
  stopDigestScheduler();                           // never leave a second timer behind
  digestTimer = setInterval(safeTick, CHECK_MS);
  digestTimer.unref?.();                           // never hold the process open
  safeTick();

  log.info('digest enabled', { hour, weeklyDay, timezone });
  return { stop: stopDigestScheduler };
}
