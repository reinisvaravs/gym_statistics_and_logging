/*
 * Strava import for cycling rides.
 *
 * Getting the three env vars (one-time setup):
 *   1. Create an API application at https://www.strava.com/settings/api
 *      ("Authorization Callback Domain" can be `localhost`). This gives you
 *      STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.
 *   2. Open this URL in a browser (replace CLIENT_ID) and click Authorize:
 *        https://www.strava.com/oauth/authorize?client_id=CLIENT_ID
 *          &response_type=code&redirect_uri=http://localhost/exchange_token
 *          &approval_prompt=force&scope=activity:read_all
 *      The scope must be `activity:read_all` — plain `activity:read` hides
 *      activities you marked private.
 *   3. The browser lands on a broken localhost page whose URL contains
 *      `?code=XXXX`. Exchange that code for tokens:
 *        curl -X POST https://www.strava.com/api/v3/oauth/token \
 *          -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \
 *          -d code=XXXX -d grant_type=authorization_code
 *      Copy `refresh_token` from the JSON into STRAVA_REFRESH_TOKEN.
 *
 * Then:  node scripts/import-strava.js --after=2026-01-01
 */

import * as db from './db.js';

const OAUTH_URL = 'https://www.strava.com/api/v3/oauth/token';
const ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities';

// Strava's own auto-generated activity names. They carry no information, and this
// project's rule is that `note` never holds measured values or noise — so we drop them.
const DEFAULT_NAMES = /^(morning|afternoon|evening|lunch|night)\s+(ride|virtual ride|cycle)$/i;

const CYCLING_TYPES = new Set(['Ride', 'VirtualRide']);

// Duplicate tolerances — Strava and a hand-entered ride never match to the digit.
const KM_TOLERANCE = 0.2;
const MIN_TOLERANCE = 1;

function env() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;
  const missing = [
    !clientId && 'STRAVA_CLIENT_ID',
    !clientSecret && 'STRAVA_CLIENT_SECRET',
    !refreshToken && 'STRAVA_REFRESH_TOKEN',
  ].filter(Boolean);
  if (missing.length) throw new Error(`Strava is not configured — missing ${missing.join(', ')} (see the comment at the top of src/strava.js)`);
  return { clientId, clientSecret, refreshToken };
}

/* ------------------------------------------------------------------- auth */

// Access tokens live ~6h, so one refresh per process is plenty; cache in memory.
let cached = null;   // { token, expiresAt (epoch seconds) }

// Strava ROTATES the refresh token on every refresh: the response may contain a
// different refresh_token than the one we sent, and the old one keeps working only
// for a short grace period. We surface it as `newRefreshToken` so the CLI can tell
// the user to update STRAVA_REFRESH_TOKEN in their env instead of silently breaking
// the next import.
export let newRefreshToken = null;

export async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 60 > now) return cached.token;

  const { clientId, clientSecret, refreshToken } = env();
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await readBody(res);
  if (!res.ok) throw new Error(`Strava token refresh failed (${res.status}): ${describe(body)}`);

  if (body.refresh_token && body.refresh_token !== refreshToken) newRefreshToken = body.refresh_token;
  cached = { token: body.access_token, expiresAt: body.expires_at ?? now + 3600 };
  return cached.token;
}

/* ------------------------------------------------------------------- fetch */

async function readBody(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 200) }; }
}

const describe = b => b?.message || (b?.errors && JSON.stringify(b.errors)) || 'no detail';

async function api(url) {
  const token = await getAccessToken();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    // Strava allows 100 requests / 15 min and 1000 / day. There is no point retrying
    // in-process — the window is 15 minutes — so fail loudly with the reset hint.
    const usage = res.headers.get('x-ratelimit-usage') || 'unknown';
    throw new Error(`Strava rate limit hit (429). Usage so far: ${usage}. Wait ~15 minutes and re-run.`);
  }
  if (res.status === 401) throw new Error('Strava rejected the token (401) — STRAVA_REFRESH_TOKEN is probably stale or lacks the activity:read_all scope.');
  const body = await readBody(res);
  if (!res.ok) throw new Error(`Strava API ${res.status} on ${new URL(url).pathname}: ${describe(body)}`);
  return body;
}

// Epoch seconds for a YYYY-MM-DD boundary. Strava's after/before are UTC epochs; a
// day of slack on each end is fine because we re-filter by local date afterwards.
const epoch = (date, endOfDay = false) =>
  Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) + (endOfDay ? 86400 : 0);

// Fetch cycling activities in a window. Paginates until Strava returns a short page.
export async function listActivities({ after, before, perPage = 100 } = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const u = new URL(ACTIVITIES_URL);
    u.searchParams.set('per_page', String(perPage));
    u.searchParams.set('page', String(page));
    if (after) u.searchParams.set('after', String(epoch(after)));
    if (before) u.searchParams.set('before', String(epoch(before, true)));

    const batch = await api(u.toString());
    if (!Array.isArray(batch)) throw new Error('Strava returned an unexpected activities payload');
    out.push(...batch.filter(a => CYCLING_TYPES.has(a.sport_type || a.type)));
    if (batch.length < perPage) break;          // short page = last page
    if (page > 50) break;                       // safety net against an endless loop
  }
  return out;
}

/* ----------------------------------------------------------------- mapping */

const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
const r0 = v => (v == null ? null : Math.round(v));

// Map one Strava activity onto the object db.addRide accepts.
export function toRide(a) {
  const indoors = (a.sport_type || a.type) === 'VirtualRide' || a.trainer === true;
  const name = (a.name || '').trim();
  const ride = {
    // start_date_local is an ISO string already shifted into the athlete's timezone,
    // so its date part IS the local calendar date — no TZ math needed.
    date: String(a.start_date_local || a.start_date || '').slice(0, 10),
    location: indoors ? 'indoors' : 'outdoors',
    durationMin: a.moving_time != null ? r1(a.moving_time / 60) : null,
    distanceKm: a.distance != null ? r1(a.distance / 1000) : null,
    speedKmh: a.average_speed != null ? r1(a.average_speed * 3.6) : null,
    avgHr: r0(a.average_heartrate),
    avgWatts: r0(a.average_watts),
    avgCadence: r0(a.average_cadence),
    note: name && !DEFAULT_NAMES.test(name) ? name : null,
  };
  return ride;
}

/* ----------------------------------------------------------------- import */

const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

// A Strava ride duplicates an existing one when it lands on the same date with
// near-identical distance and duration. Same-date rides with clearly different
// numbers (a commute plus an evening loop) are kept.
function isDuplicate(ride, existing) {
  return existing.some(e =>
    e.date === ride.date &&
    near(ride.distanceKm, e.distanceKm, KM_TOLERANCE) &&
    near(ride.durationMin, e.durationMin, MIN_TOLERANCE));
}

export async function importRides({ after, before, dryRun = false } = {}) {
  const activities = await listActivities({ after, before });
  const rides = activities.map(toRide).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  rides.sort((a, b) => a.date.localeCompare(b.date));

  // One lookup for the whole window; findEntries caps at `limit`, so ask for enough
  // to cover a dense window rather than paging per day.
  const existing = rides.length
    ? await db.findEntries({
        type: 'ride',
        dateFrom: after || rides[0].date,
        dateTo: before || rides.at(-1).date,
        limit: 1000,
      })
    : [];

  const out = [], seen = existing.slice();
  let imported = 0, skipped = 0;

  for (const ride of rides) {
    if (isDuplicate(ride, seen)) {
      skipped++;
      out.push({ ...ride, status: 'skipped' });
      continue;
    }
    if (!dryRun) await db.addRide(ride);
    // Track it either way so two identical Strava activities in one run don't both land.
    seen.push(ride);
    imported++;
    out.push({ ...ride, status: dryRun ? 'would-import' : 'imported' });
  }

  return { imported, skipped, rides: out, newRefreshToken };
}
