import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/* ------------------------------------------------ read: frontend-shaped blob */

// Returns the exact shape the charts expect: { strength:[{key,name,sessions}], rides, bodyweight }.
export async function assembleData() {
  const [order, sessions, rides, bw] = await Promise.all([
    // exercises in first-appearance order → stable color slots (tie-break by insert time)
    q(`SELECT exercise_key, min(exercise_name) AS name, min(date)::text AS first_date, min(created_at) AS first_created
         FROM strength_sessions GROUP BY exercise_key ORDER BY first_date, first_created`),
    q(`SELECT id, date::text AS d, exercise_key, sets FROM strength_sessions ORDER BY date, created_at`),
    q(`SELECT id, date::text AS d, location, duration_min, distance_km, speed_kmh,
              avg_hr, avg_watts, avg_cadence, note FROM rides ORDER BY date`),
    q(`SELECT id, date::text AS d, weight_kg FROM bodyweight ORDER BY date`),
  ]);

  const byKey = new Map(order.map(o => [o.exercise_key, { key: o.exercise_key, name: o.name, sessions: [] }]));
  for (const r of sessions) byKey.get(r.exercise_key).sessions.push({ id: r.id, d: r.d, sets: r.sets });
  const strength = order.map(o => byKey.get(o.exercise_key));

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

export async function addStrength({ date, exercise, exerciseName, sets }) {
  const clean = (sets || []).map(s => {
    const o = { w: +(s.weightKg ?? s.w), r: +(s.reps ?? s.r) };
    const a = +(s.assistedReps ?? s.a ?? 0);
    if (a) o.a = a;
    return o;
  }).filter(s => Number.isFinite(s.w) && Number.isFinite(s.r));
  if (!clean.length) throw new Error('no valid sets');
  const key = String(exercise).toLowerCase().replace(/[^a-z0-9]/g, '') || 'other';
  const [row] = await q(
    `INSERT INTO strength_sessions (date, exercise_key, exercise_name, sets)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [date, key, exerciseName || key, JSON.stringify(clean)]);
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
  return { id: row.id, kind: 'ride', date: r.date, location: loc };
}

export async function addBodyweight({ date, weightKg }) {
  const kg = +(weightKg);
  if (!Number.isFinite(kg)) throw new Error('bad weight');
  const [row] = await q(`INSERT INTO bodyweight (date, weight_kg) VALUES ($1,$2) RETURNING id`, [date, kg]);
  return { id: row.id, kind: 'bodyweight', date, weightKg: kg };
}

/* ----------------------------------------------------------- CRUD: read/find */

const TABLE = { strength: 'strength_sessions', ride: 'rides', bodyweight: 'bodyweight' };

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
    if (exercise) { p.push(exercise.toLowerCase()); where.push(`exercise_key = $${p.length}`); }
    const rows = await q(`SELECT id, date::text AS d, exercise_key, exercise_name, sets
       FROM strength_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY date DESC LIMIT ${+limit}`, p);
    rows.forEach(r => out.push({ type: 'strength', id: r.id, date: r.d, exercise: r.exercise_key,
      exerciseName: r.exercise_name, sets: r.sets,
      summary: `${r.exercise_name} on ${r.d}: ${r.sets.map(s => `${s.w}kg×${s.r}${s.a ? `+${s.a}` : ''}`).join(', ')}` }));
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

const num = v => (v == null ? null : +v);

/* --------------------------------------------------------- CRUD: update/delete */

export async function updateEntry({ type, id, fields }) {
  if (!TABLE[type]) throw new Error('unknown type');
  if (type === 'strength') {
    const sets = fields.sets && fields.sets.map(s => {
      const o = { w: +(s.weightKg ?? s.w), r: +(s.reps ?? s.r) };
      const a = +(s.assistedReps ?? s.a ?? 0); if (a) o.a = a; return o;
    });
    const cols = [], p = [];
    if (fields.date)         { p.push(fields.date);         cols.push(`date = $${p.length}`); }
    if (fields.exercise)     { p.push(fields.exercise.toLowerCase()); cols.push(`exercise_key = $${p.length}`); }
    if (fields.exerciseName) { p.push(fields.exerciseName); cols.push(`exercise_name = $${p.length}`); }
    if (sets)                { p.push(JSON.stringify(sets)); cols.push(`sets = $${p.length}`); }
    if (!cols.length) throw new Error('nothing to update');
    p.push(id);
    const rows = await q(`UPDATE strength_sessions SET ${cols.join(', ')} WHERE id = $${p.length} RETURNING id`, p);
    if (!rows.length) throw new Error('not found');
    return { updated: rows.length };
  }
  if (type === 'ride') {
    const map = { date: 'date', location: 'location', durationMin: 'duration_min', distanceKm: 'distance_km',
      speedKmh: 'speed_kmh', avgHr: 'avg_hr', avgWatts: 'avg_watts', avgCadence: 'avg_cadence', note: 'note' };
    const cols = [], p = [];
    for (const [k, col] of Object.entries(map)) {
      if (k in fields) {
        let v = fields[k];
        if (k === 'location') v = (v === 'outdoors' || v === 'out') ? 'out' : 'in';
        p.push(v); cols.push(`${col} = $${p.length}`);
      }
    }
    if (!cols.length) throw new Error('nothing to update');
    p.push(id);
    const rows = await q(`UPDATE rides SET ${cols.join(', ')} WHERE id = $${p.length} RETURNING id`, p);
    if (!rows.length) throw new Error('not found');
    return { updated: rows.length };
  }
  // bodyweight
  const cols = [], p = [];
  if (fields.date)     { p.push(fields.date); cols.push(`date = $${p.length}`); }
  if (fields.weightKg != null) { p.push(+fields.weightKg); cols.push(`weight_kg = $${p.length}`); }
  if (!cols.length) throw new Error('nothing to update');
  p.push(id);
  const rows = await q(`UPDATE bodyweight SET ${cols.join(', ')} WHERE id = $${p.length} RETURNING id`, p);
  if (!rows.length) throw new Error('not found');
  return { updated: rows.length };
}

export async function deleteEntry({ type, id }) {
  if (!TABLE[type]) throw new Error('unknown type');
  const rows = await q(`DELETE FROM ${TABLE[type]} WHERE id = $1 RETURNING id`, [id]);
  if (!rows.length) throw new Error('not found');
  return { deleted: rows.length };
}

/* ---------------------------------------------------------------- statistics */

export async function getStatistics() {
  const data = await assembleData();
  const e1rm = s => s.w * (1 + s.r / 30);
  const strengthStats = data.strength.map(ex => {
    const best = ex.sessions.flatMap(s => s.sets).reduce((m, s) => Math.max(m, e1rm(s)), 0);
    const topWeight = ex.sessions.flatMap(s => s.sets).reduce((m, s) => Math.max(m, s.w), 0);
    return { exercise: ex.name, sessions: ex.sessions.length,
      estimated1RM: Math.round(best * 10) / 10, heaviestKg: topWeight };
  });
  const rides = data.rides;
  const out = rides.filter(r => r.loc === 'out'), inn = rides.filter(r => r.loc === 'in');
  const avg = rs => { const s = rs.filter(r => r.kmh); return s.length ? Math.round(s.reduce((a, r) => a + r.kmh, 0) / s.length * 10) / 10 : null; };
  return {
    totalSessions: new Set([...data.strength.flatMap(e => e.sessions.map(s => s.d)), ...rides.map(r => r.d)]).size,
    strength: strengthStats,
    cycling: { totalRides: rides.length, totalKm: Math.round(rides.reduce((a, r) => a + (r.km || 0), 0) * 10) / 10,
      avgSpeedOutdoors: avg(out), avgSpeedIndoors: avg(inn) },
    latestBodyweightKg: data.bodyweight.at(-1)?.kg ?? null,
  };
}

export async function isEmpty() {
  const [{ n }] = await q(
    `SELECT (SELECT count(*) FROM strength_sessions) + (SELECT count(*) FROM rides) + (SELECT count(*) FROM bodyweight) AS n`);
  return +n === 0;
}
