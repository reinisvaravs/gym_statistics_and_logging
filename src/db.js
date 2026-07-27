import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { today, addDays, daysBetween, weekStart } from './time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_NO_SSL === 'true' ? false : { rejectUnauthorized: false },
});

export async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

const q = (text, params) => pool.query(text, params).then(r => r.rows);
const round = (v, n = 2) => (v == null ? null : Math.round(+v * 10 ** n) / 10 ** n);
const num = v => (v == null ? null : +v);

const TABLE = { strength: 'strength_sessions', ride: 'rides', bodyweight: 'bodyweight' };

/* --------------------------------------------------------------------- audit */

// Every mutation is journalled so `undoLast` can reverse a misunderstood instruction.
async function logAudit(action, entryType, entryId, before, after) {
  await q(`INSERT INTO audit_log (action, entry_type, entry_id, before, after) VALUES ($1,$2,$3,$4,$5)`,
    [action, entryType, entryId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

const snapshot = async (type, id) => {
  const [row] = await q(`SELECT to_jsonb(t) AS r FROM ${TABLE[type]} t WHERE id = $1`, [id]);
  return row?.r ?? null;
};

/* ---------------------------------------------------------------- set shapes */

// A set is { w, r, a?, rpe?, bw? }. Weight is OPTIONAL: bodyweight lifts (pull-ups, dips)
// carry bw:true and use `w` for *added* kg only. Reps are the one required field.
function normalizeSets(sets) {
  const clean = (sets || []).map(s => {
    const reps = +(s.reps ?? s.r);
    if (!Number.isFinite(reps)) return null;

    const bw = s.bodyweight ?? s.bw ?? false;
    const rawW = s.weightKg ?? s.w;
    const w = Number.isFinite(+rawW) ? +rawW : null;
    if (!bw && w == null) return null;              // a weighted lift needs a weight

    const o = { w: bw ? (w || 0) : w, r: reps };
    const a = +(s.assistedReps ?? s.a ?? 0);
    if (a) o.a = a;
    const rpe = +(s.rpe ?? 0);
    if (rpe) o.rpe = rpe;
    if (bw) o.bw = true;
    return o;
  }).filter(Boolean);
  if (!clean.length) throw new Error('no valid sets (each set needs reps, and weight unless it is a bodyweight exercise)');
  return clean;
}

// Assisted reps are half-reps by this project's convention ("70x7.5" = 7 + 1 assisted).
const effectiveReps = s => s.r + (s.a || 0) * 0.5;

// What the set actually loaded, in kg. Bodyweight sets need the athlete's weight, which
// is why callers thread a bodyweight-at-date lookup through.
const setLoad = (s, bwKg) => (s.bw ? (bwKg ?? 0) + (s.w || 0) : (s.w || 0));

const epley = (load, reps) => load * (1 + reps / 30);

// "Bench press" and "bench-press" must collapse to the same key on insert AND on edit,
// or an edit silently forks the exercise into a second series.
const exerciseKey = v => String(v).toLowerCase().replace(/[^a-z0-9]/g, '') || 'other';

// The session's hardest set: heaviest, and among equal weights the one with most reps.
// Weight and reps must come from the SAME set or a suggestion reads back as a lift that
// never happened. For bodyweight lifts every w is equal, so this picks the longest set.
const topSet = sets => sets.reduce((best, s) =>
  (s.w || 0) > (best.w || 0) || ((s.w || 0) === (best.w || 0) && s.r > best.r) ? s : best, sets[0]);

// Bodyweight readings are sparse, so carry the most recent one forward to each date.
async function bodyweightLookup() {
  const rows = await q(`SELECT date::text AS d, weight_kg FROM bodyweight ORDER BY date`);
  if (!rows.length) return () => null;
  return date => {
    let kg = null;
    for (const r of rows) { if (r.d <= date) kg = +r.weight_kg; else break; }
    return kg ?? +rows[0].weight_kg;   // before the first reading, use the earliest
  };
}

/* ------------------------------------------------ read: frontend-shaped blob */

// Returns the exact shape the charts expect: { strength:[{key,name,sessions}], rides, bodyweight }.
// Optional { from, to } (YYYY-MM-DD) narrow the range; omitted means the whole history.
export async function assembleData({ from, to } = {}) {
  const range = (col = 'date') => {
    const where = [], p = [];
    if (from) { p.push(from); where.push(`${col} >= $${p.length}`); }
    if (to)   { p.push(to);   where.push(`${col} <= $${p.length}`); }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', p };
  };
  const s = range(), r = range(), b = range();

  const [order, sessions, rides, bw] = await Promise.all([
    // exercises in first-appearance order → stable color slots (tie-break by insert time)
    q(`SELECT exercise_key, min(exercise_name) AS name, min(date)::text AS first_date, min(created_at) AS first_created
         FROM strength_sessions ${s.clause} GROUP BY exercise_key ORDER BY first_date, first_created`, s.p),
    q(`SELECT id, date::text AS d, exercise_key, sets, note FROM strength_sessions ${s.clause} ORDER BY date, created_at`, s.p),
    q(`SELECT id, date::text AS d, location, duration_min, distance_km, speed_kmh,
              avg_hr, avg_watts, avg_cadence, note FROM rides ${r.clause} ORDER BY date`, r.p),
    q(`SELECT id, date::text AS d, weight_kg FROM bodyweight ${b.clause} ORDER BY date`, b.p),
  ]);

  const bwAt = await bodyweightLookup();

  const byKey = new Map(order.map(o => [o.exercise_key, { key: o.exercise_key, name: o.name, sessions: [], bodyweightLift: true }]));
  for (const r of sessions) {
    const ex = byKey.get(r.exercise_key);
    const session = { id: r.id, d: r.d, sets: r.sets };
    if (r.note) session.note = r.note;
    ex.sessions.push(session);
    // Rows written before bodyweight lifts were supported landed as 0kg. An exercise whose
    // sets never carry a load is bodyweight work, flagged or not — otherwise its whole
    // history charts as a flat zero.
    if (!r.sets.every(s => s.bw || !(s.w > 0))) ex.bodyweightLift = false;
  }
  const strength = order.map(o => byKey.get(o.exercise_key));

  // Metrics come after the pass above, because loading a bodyweight set needs to know the
  // exercise is bodyweight work before it can price the reps.
  for (const ex of strength) {
    for (const s of ex.sessions) {
      const load = set => (ex.bodyweightLift ? (bwAt(s.d) ?? 0) + (set.w || 0) : setLoad(set, bwAt(s.d)));
      s.volume = round(s.sets.reduce((t, x) => t + load(x) * effectiveReps(x), 0), 0);
      s.e1rm = round(s.sets.reduce((m, x) => Math.max(m, epley(load(x), effectiveReps(x))), 0), 1);
    }
  }

  const ridesOut = rides.map(r => {
    const o = { id: r.id, d: r.d, loc: r.location };
    if (r.duration_min != null) o.min = round(r.duration_min);
    if (r.distance_km  != null) o.km  = round(r.distance_km);
    if (r.speed_kmh    != null) o.kmh = round(r.speed_kmh);
    if (r.avg_hr       != null) o.bpm = round(r.avg_hr, 0);
    if (r.avg_watts    != null) o.w   = round(r.avg_watts, 0);
    if (r.avg_cadence  != null) o.rpm = round(r.avg_cadence, 0);
    if (r.note) o.note = r.note;
    return o;
  });

  const bodyweight = bw.map(b => ({ id: b.id, d: b.d, kg: round(b.weight_kg) }));
  return { strength, rides: ridesOut, bodyweight };
}

/* --------------------------------------------------------------- CRUD: create */

export async function addStrength({ date, exercise, exerciseName, sets, note }) {
  const clean = normalizeSets(sets);
  const key = exerciseKey(exercise);
  const [row] = await q(
    `INSERT INTO strength_sessions (date, exercise_key, exercise_name, sets, note)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [date, key, exerciseName || key, JSON.stringify(clean), note ?? null]);
  await logAudit('insert', 'strength', row.id, null, await snapshot('strength', row.id));
  return { id: row.id, kind: 'strength', date, exercise: key, sets: clean };
}

export async function addRide(r) {
  const loc = (r.location === 'outdoors' || r.location === 'out') ? 'out' : 'in';
  let kmh = r.speedKmh ?? r.kmh ?? null;
  const min = r.durationMin ?? r.min ?? null, km = r.distanceKm ?? r.km ?? null;
  if (kmh == null && km != null && min) kmh = Math.round((km / (min / 60)) * 10) / 10;
  const [row] = await q(
    `INSERT INTO rides (date, location, duration_min, distance_km, speed_kmh, avg_hr, avg_watts, avg_cadence, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [r.date, loc, min, km, kmh, r.avgHr ?? r.bpm ?? null,
     r.avgWatts ?? r.w ?? null, r.avgCadence ?? r.rpm ?? null, r.note ?? null]);
  await logAudit('insert', 'ride', row.id, null, await snapshot('ride', row.id));
  return { id: row.id, kind: 'ride', date: r.date, location: loc };
}

export async function addBodyweight({ date, weightKg }) {
  const kg = +(weightKg);
  if (!Number.isFinite(kg)) throw new Error('bad weight');
  const [row] = await q(`INSERT INTO bodyweight (date, weight_kg) VALUES ($1,$2) RETURNING id`, [date, kg]);
  await logAudit('insert', 'bodyweight', row.id, null, await snapshot('bodyweight', row.id));
  return { id: row.id, kind: 'bodyweight', date, weightKg: kg };
}

/* ----------------------------------------------------------- CRUD: read/find */

// flexible search the AI uses before editing/deleting; returns rows with ids
export async function findEntries({ type, dateFrom, dateTo, exercise, limit = 25 } = {}) {
  const out = [];
  const wantStrength = !type || type === 'strength';
  const wantRide     = !type || type === 'ride';
  const wantBw       = !type || type === 'bodyweight';

  if (wantStrength) {
    const where = [], p = [];
    if (dateFrom) { p.push(dateFrom); where.push(`date >= $${p.length}`); }
    if (dateTo)   { p.push(dateTo);   where.push(`date <= $${p.length}`); }
    if (exercise) { p.push(exerciseKey(exercise)); where.push(`exercise_key = $${p.length}`); }
    const rows = await q(`SELECT id, date::text AS d, exercise_key, exercise_name, sets, note
       FROM strength_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY date DESC LIMIT ${+limit}`, p);
    rows.forEach(r => out.push({ type: 'strength', id: r.id, date: r.d, exercise: r.exercise_key,
      exerciseName: r.exercise_name, sets: r.sets, note: r.note,
      summary: `${r.exercise_name} on ${r.d}: ${r.sets.map(describeSet).join(', ')}` }));
  }
  if (wantRide) {
    const where = [], p = [];
    if (dateFrom) { p.push(dateFrom); where.push(`date >= $${p.length}`); }
    if (dateTo)   { p.push(dateTo);   where.push(`date <= $${p.length}`); }
    const rows = await q(`SELECT id, date::text AS d, location, duration_min, distance_km, speed_kmh, avg_hr, avg_watts, avg_cadence, note
       FROM rides ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC LIMIT ${+limit}`, p);
    rows.forEach(r => out.push({ type: 'ride', id: r.id, date: r.d, location: r.location === 'in' ? 'indoors' : 'outdoors',
      durationMin: num(r.duration_min), distanceKm: num(r.distance_km), speedKmh: num(r.speed_kmh),
      avgHr: num(r.avg_hr), avgWatts: num(r.avg_watts), avgCadence: num(r.avg_cadence), note: r.note,
      summary: `Bike (${r.location === 'in' ? 'indoors' : 'outdoors'}) on ${r.d}` +
               `${r.distance_km ? `, ${num(r.distance_km)}km` : ''}${r.speed_kmh ? `, ${num(r.speed_kmh)}km/h` : ''}` }));
  }
  if (wantBw) {
    const where = [], p = [];
    if (dateFrom) { p.push(dateFrom); where.push(`date >= $${p.length}`); }
    if (dateTo)   { p.push(dateTo);   where.push(`date <= $${p.length}`); }
    const rows = await q(`SELECT id, date::text AS d, weight_kg FROM bodyweight
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC LIMIT ${+limit}`, p);
    rows.forEach(r => out.push({ type: 'bodyweight', id: r.id, date: r.d, weightKg: num(r.weight_kg),
      summary: `Bodyweight on ${r.d}: ${num(r.weight_kg)}kg` }));
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, +limit);
}

const describeSet = s =>
  (s.bw ? (s.w ? `BW+${s.w}kg×${s.r}` : `BW×${s.r}`) : `${s.w}kg×${s.r}`) +
  (s.a ? `+${s.a}` : '') + (s.rpe ? ` @${s.rpe}` : '');

/* --------------------------------------------------------- CRUD: update/delete */

export async function updateEntry({ type, id, fields }) {
  if (!TABLE[type]) throw new Error('unknown type');
  const before = await snapshot(type, id);
  if (!before) throw new Error('not found');

  const cols = [], p = [];
  const push = (col, v) => { p.push(v); cols.push(`${col} = $${p.length}`); };

  if (type === 'strength') {
    if (fields.date)         push('date', fields.date);
    if (fields.exercise)     push('exercise_key', exerciseKey(fields.exercise));
    if (fields.exerciseName) push('exercise_name', fields.exerciseName);
    if (fields.sets)         push('sets', JSON.stringify(normalizeSets(fields.sets)));
    if ('note' in fields)    push('note', fields.note ?? null);
  } else if (type === 'ride') {
    const map = { date: 'date', location: 'location', durationMin: 'duration_min', distanceKm: 'distance_km',
      speedKmh: 'speed_kmh', avgHr: 'avg_hr', avgWatts: 'avg_watts', avgCadence: 'avg_cadence', note: 'note' };
    for (const [k, col] of Object.entries(map)) {
      if (k in fields) {
        let v = fields[k];
        if (k === 'location') v = (v === 'outdoors' || v === 'out') ? 'out' : 'in';
        push(col, v);
      }
    }
  } else {
    if (fields.date) push('date', fields.date);
    if (fields.weightKg != null) push('weight_kg', +fields.weightKg);
  }
  if (!cols.length) throw new Error('nothing to update');

  p.push(id);
  const rows = await q(`UPDATE ${TABLE[type]} SET ${cols.join(', ')} WHERE id = $${p.length} RETURNING id`, p);
  if (!rows.length) throw new Error('not found');
  await logAudit('update', type, id, before, await snapshot(type, id));
  return { updated: rows.length };
}

export async function deleteEntry({ type, id }) {
  if (!TABLE[type]) throw new Error('unknown type');
  const before = await snapshot(type, id);
  if (!before) throw new Error('not found');
  await q(`DELETE FROM ${TABLE[type]} WHERE id = $1`, [id]);
  await logAudit('delete', type, id, before, null);
  return { deleted: 1 };
}

/* ----------------------------------------------------------------------- undo */

// Reverse the most recent mutation. Undo itself is not journalled — it marks the
// entry it reversed, so repeated calls walk further back rather than ping-ponging.
export async function undoLast() {
  const [entry] = await q(`SELECT * FROM audit_log WHERE undone = false ORDER BY at DESC, id DESC LIMIT 1`);
  if (!entry) return { undone: false, message: 'Nothing to undo.' };

  const table = TABLE[entry.entry_type];
  if (!table) throw new Error(`cannot undo unknown type ${entry.entry_type}`);

  if (entry.action === 'insert') {
    await q(`DELETE FROM ${table} WHERE id = $1`, [entry.entry_id]);
  } else if (entry.action === 'delete') {
    await restoreRow(table, entry.before);
  } else {
    await restoreRow(table, entry.before, true);
  }
  await q(`UPDATE audit_log SET undone = true WHERE id = $1`, [entry.id]);
  return { undone: true, action: entry.action, type: entry.entry_type, restored: entry.before ?? null };
}

// Write a to_jsonb() snapshot back into its table, inserting or overwriting in place.
async function restoreRow(table, row, update = false) {
  const cols = Object.keys(row);
  const vals = cols.map(c => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]));
  if (update) {
    const sets = cols.filter(c => c !== 'id').map((c, i) => `${c} = $${i + 1}`);
    await q(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${cols.length}`,
      [...cols.filter(c => c !== 'id').map(c => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])), row.id]);
    return;
  }
  const ph = cols.map((_, i) => `$${i + 1}`);
  await q(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph.join(', ')}) ON CONFLICT (id) DO NOTHING`, vals);
}

/* ---------------------------------------------------------------- statistics */

export async function getStatistics() {
  const data = await assembleData();
  const now = today();

  const strengthStats = data.strength.map(ex => {
    const last = ex.sessions.at(-1);
    const best = ex.sessions.reduce((m, s) => Math.max(m, s.e1rm || 0), 0);
    const topWeight = ex.sessions.flatMap(s => s.sets).reduce((m, s) => Math.max(m, s.w || 0), 0);
    const topReps = ex.sessions.flatMap(s => s.sets).reduce((m, s) => Math.max(m, s.r), 0);
    return {
      exercise: ex.name, key: ex.key, sessions: ex.sessions.length,
      bodyweightLift: ex.bodyweightLift,
      estimated1RM: round(best, 1),
      heaviestKg: ex.bodyweightLift ? null : topWeight,
      bestReps: ex.bodyweightLift ? topReps : null,
      totalVolumeKg: round(ex.sessions.reduce((t, s) => t + (s.volume || 0), 0), 0),
      lastDate: last?.d ?? null,
      daysSince: last ? daysBetween(last.d, now) : null,
    };
  });

  const rides = data.rides;
  const out = rides.filter(r => r.loc === 'out'), inn = rides.filter(r => r.loc === 'in');
  const avg = rs => { const s = rs.filter(r => r.kmh); return s.length ? round(s.reduce((a, r) => a + r.kmh, 0) / s.length, 1) : null; };

  return {
    totalSessions: new Set([...data.strength.flatMap(e => e.sessions.map(s => s.d)), ...rides.map(r => r.d)]).size,
    strength: strengthStats,
    cycling: { totalRides: rides.length, totalKm: round(rides.reduce((a, r) => a + (r.km || 0), 0), 1),
      avgSpeedOutdoors: avg(out), avgSpeedIndoors: avg(inn) },
    latestBodyweightKg: data.bodyweight.at(-1)?.kg ?? null,
    // 12 weeks: long enough for the weekly-volume chart to show a trend, short enough
    // that it still reflects current training rather than the whole history.
    volume: await getVolume({ from: addDays(now, -84), to: now }),
  };
}

// Tonnage (kg lifted) over a window, total and per exercise, plus a per-week breakdown.
export async function getVolume({ from, to } = {}) {
  const data = await assembleData({ from, to });
  const perExercise = data.strength.map(ex => ({
    exercise: ex.name, key: ex.key,
    volumeKg: round(ex.sessions.reduce((t, s) => t + (s.volume || 0), 0), 0),
    sessions: ex.sessions.length,
  })).filter(e => e.volumeKg > 0).sort((a, b) => b.volumeKg - a.volumeKg);

  const weeks = new Map();
  for (const ex of data.strength) {
    for (const s of ex.sessions) {
      const w = weekStart(s.d);
      weeks.set(w, (weeks.get(w) || 0) + (s.volume || 0));
    }
  }
  return {
    from: from ?? null, to: to ?? null,
    totalKg: round(perExercise.reduce((t, e) => t + e.volumeKg, 0), 0),
    perExercise,
    perWeek: [...weeks.entries()].sort().map(([week, volumeKg]) => ({ week, volumeKg: round(volumeKg, 0) })),
  };
}

// One lift over time — the shape the e1RM chart wants.
export async function getExerciseSeries(exercise) {
  const data = await assembleData();
  const ex = data.strength.find(e => e.key === exerciseKey(exercise));
  if (!ex) return null;
  return {
    exercise: ex.name, key: ex.key, bodyweightLift: ex.bodyweightLift,
    points: ex.sessions.map(s => {
      const top = topSet(s.sets);
      return {
        date: s.d, e1rm: s.e1rm, volumeKg: s.volume,
        topSetKg: top.w || 0, topSetReps: top.r,
        sets: s.sets.map(describeSet).join(', '),
      };
    }),
  };
}

// Last time each lift was trained — the input to staleness nudges.
export async function getLastSessions(now = today()) {
  const rows = await q(`SELECT exercise_key, min(exercise_name) AS name, max(date)::text AS last_date,
                               count(*)::int AS sessions
                          FROM strength_sessions GROUP BY exercise_key ORDER BY max(date) DESC`);
  const [ride] = await q(`SELECT max(date)::text AS d FROM rides`);
  return {
    strength: rows.map(r => ({ key: r.exercise_key, exercise: r.name, lastDate: r.last_date,
      daysSince: daysBetween(r.last_date, now), sessions: r.sessions })),
    lastRideDate: ride?.d ?? null,
    daysSinceRide: ride?.d ? daysBetween(ride.d, now) : null,
  };
}

// This week vs last week, plus any lift whose e1RM beat everything before it this week.
export async function getWeeklySummary(now = today()) {
  const thisWeek = weekStart(now);
  const lastWeek = addDays(thisWeek, -7);
  const all = await assembleData();

  const window = (from, to) => {
    const sessions = all.strength.flatMap(ex => ex.sessions.filter(s => s.d >= from && s.d <= to));
    const rides = all.rides.filter(r => r.d >= from && r.d <= to);
    return {
      from, to,
      strengthSessions: sessions.length,
      volumeKg: round(sessions.reduce((t, s) => t + (s.volume || 0), 0), 0),
      rides: rides.length,
      rideKm: round(rides.reduce((t, r) => t + (r.km || 0), 0), 1),
      trainingDays: new Set([...sessions.map(s => s.d), ...rides.map(r => r.d)]).size,
    };
  };

  const prs = [];
  for (const ex of all.strength) {
    let best = 0;
    for (const s of ex.sessions) {
      if (s.d >= thisWeek && s.e1rm > best) prs.push({ exercise: ex.name, key: ex.key, date: s.d, e1rm: s.e1rm, previousBest: round(best, 1) });
      best = Math.max(best, s.e1rm || 0);
    }
  }
  // keep only the best PR per lift
  const bestPr = new Map();
  for (const p of prs) if (!bestPr.has(p.key) || bestPr.get(p.key).e1rm < p.e1rm) bestPr.set(p.key, p);

  return { thisWeek: window(thisWeek, now), lastWeek: window(lastWeek, addDays(thisWeek, -1)), prs: [...bestPr.values()] };
}

// Progressive overload from the athlete's own last session. Deliberately conservative:
// hold the weight and add a rep until the top set is strong, then add the smallest plate.
export async function suggestNext(exercise) {
  const series = await getExerciseSeries(exercise);
  if (!series || !series.points.length) return null;
  const last = series.points.at(-1);
  const name = series.exercise;

  if (series.bodyweightLift) {
    return { exercise: name, key: series.key, lastDate: last.date, lastSets: last.sets,
      suggestion: `${name}: last ${last.topSetReps} reps — aim for ${last.topSetReps + 1} on the top set.` };
  }
  const kg = last.topSetKg, reps = last.topSetReps;
  const next = reps >= 8
    ? { kg: round(kg + 2.5, 1), reps: Math.max(5, reps - 3) }
    : { kg, reps: reps + 1 };
  return { exercise: name, key: series.key, lastDate: last.date, lastSets: last.sets,
    targetKg: next.kg, targetReps: next.reps,
    suggestion: `${name}: last ${kg}kg×${reps} — try ${next.kg}kg×${next.reps}.` };
}

export async function isEmpty() {
  const [{ n }] = await q(
    `SELECT (SELECT count(*) FROM strength_sessions) + (SELECT count(*) FROM rides) + (SELECT count(*) FROM bodyweight) AS n`);
  return +n === 0;
}
