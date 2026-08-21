import OpenAI from 'openai';
import { config } from './config.js';
import * as db from './db.js';
import { today, timezone } from './time.js';

const client = new OpenAI({ apiKey: config.openai.apiKey, timeout: 60_000, maxRetries: 2 });
const MODEL = config.openai.model;

const SYSTEM = `You are the assistant behind a personal gym-tracking Telegram bot. The owner logs
workouts and asks questions in plain language; you call tools to add, edit, delete, or read entries
in their database, then reply with a short, friendly confirmation.

Data model:
- STRENGTH sessions: a lift (bench, squat, lat pulldown, deadlift, overhead press, row, pull-ups, dips, ...)
  on a date, with sets. Each set has reps (required) plus:
  - weightKg — the load. Required for ordinary weighted lifts.
  - bodyweight — set TRUE for lifts where the owner's own body is the load (pull-ups, chin-ups, dips,
    push-ups). Then weightKg means *added* weight only: 0 or omitted for unweighted, 10 for "pull-ups +10kg".
    Never invent a weightKg for a bodyweight exercise — "pull-ups 9 reps" is bodyweight:true, reps:9.
  - assistedReps — reps a spotter helped finish; the owner writes these as a half rep ("70x7.5" = 7 + 1 assisted).
  - rpe — optional 1-10 effort rating ("70x8 @8", "felt like a 9").
  A session can also carry a free-text note ("felt heavy", "back tweaked") — never numbers already captured above.
- RIDE: cycling, indoors or outdoors (different bikes; wind resistance outdoors). Fields: durationMin,
  distanceKm, speedKmh, avgHr, avgWatts, avgCadence, note. A plain "bike" with only a duration is indoors.
- BODYWEIGHT: an occasional scale reading in kg. This is the SCALE, not a bodyweight exercise — don't confuse them.

Unit rules when reading messages: "24km"=distance, "23km/h"=speed, "130bpm"=heart rate, "163W"=watts,
"84rpm"=cadence, "1h 15min"=75 minutes. Never put a measured value into a note.

Guidance:
- Resolve relative dates ("today", "yesterday") using the CURRENT DATE given to you. Format YYYY-MM-DD.
- To edit or delete, FIRST call find_entries to get the exact entry id, then call update_entry/delete_entry with that id. Never guess ids.
- If the owner says they made a mistake, or asks to undo/revert the last thing, call undo_last rather than
  reconstructing the change by hand.
- Canonical exercise keys are lowercase, no spaces: bench, squat, pulldown, deadlift, ohp, row, pullups, dips.
- Keep replies to one or two lines. Confirm what changed. If a request is ambiguous, ask a brief question instead of guessing.

Which tool to call:
- "what did I train last / recently?", "last training?", "what have I been doing?" → get_recent_activity.
- ANY cycling question (bike, ride, outdoors, indoors, speed, km, watts) → get_ride_series. NEVER
  get_exercise_series, which covers strength lifts only and knows nothing about rides.
- One lift over time, e1RM or progress on a lift → get_exercise_series.
- "what should I do today?", "what's next on bench?" → suggest_next.  Tonnage → get_volume.
- "how did this week go?" → get_weekly_summary.  Overall PRs and totals → get_statistics.

NEVER tell the owner that data does not exist based on one empty tool result. An empty result usually means the
tool or the date range was wrong, not that the training never happened.
- Tools return { found: false, reason } or a "note" field when they cannot answer — READ IT. It tells you which
  tool to call instead. Follow that redirect and call the right tool before you reply.
- Before saying "you have no X" or "you haven't trained recently", confirm it with get_recent_activity or
  get_statistics, which see the entire history.
- get_weekly_summary's "thisWeek" starts on Monday and is nearly empty early in the week; that is NOT the same as
  not having trained. Use its lastTrainingDate.`;

const TOOLS = [
  { type: 'function', function: { name: 'add_strength',
    description: 'Add a strength session (weighted or bodyweight).',
    parameters: { type: 'object', required: ['date', 'exercise', 'sets'], properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      exercise: { type: 'string', description: 'canonical key: bench, squat, pulldown, deadlift, ohp, row, pullups, dips' },
      exerciseName: { type: 'string', description: 'display name, e.g. "Bench press"' },
      note: { type: 'string', description: 'optional free-text note; never a measured value' },
      sets: { type: 'array', items: { type: 'object', required: ['reps'], properties: {
        reps: { type: 'integer' },
        weightKg: { type: 'number', description: 'load in kg; when bodyweight is true this is ADDED weight only (omit or 0 for unweighted)' },
        bodyweight: { type: 'boolean', description: 'true for pull-ups, dips, push-ups etc. where the body is the load' },
        assistedReps: { type: 'integer' },
        rpe: { type: 'number', description: 'optional 1-10 rating of perceived exertion' } } } },
    } } } },
  { type: 'function', function: { name: 'add_ride',
    description: 'Add a cycling session.',
    parameters: { type: 'object', required: ['date', 'location'], properties: {
      date: { type: 'string' }, location: { type: 'string', enum: ['indoors', 'outdoors'] },
      durationMin: { type: 'number' }, distanceKm: { type: 'number' }, speedKmh: { type: 'number' },
      avgHr: { type: 'number' }, avgWatts: { type: 'number' }, avgCadence: { type: 'number' }, note: { type: 'string' } } } } },
  { type: 'function', function: { name: 'add_bodyweight',
    description: 'Record a bodyweight reading.',
    parameters: { type: 'object', required: ['date', 'weightKg'], properties: {
      date: { type: 'string' }, weightKg: { type: 'number' } } } } },
  { type: 'function', function: { name: 'find_entries',
    description: 'Search existing entries. Use before editing or deleting to get the exact id. Returns { count, entries, note }.',
    parameters: { type: 'object', properties: {
      type: { type: 'string', enum: ['strength', 'ride', 'bodyweight'] },
      exercise: { type: 'string', description: 'strength lifts only — leave empty and use type:"ride" for cycling' },
      dateFrom: { type: 'string' }, dateTo: { type: 'string' },
      limit: { type: 'integer' } } } } },
  { type: 'function', function: { name: 'update_entry',
    description: 'Update fields of one entry by id.',
    parameters: { type: 'object', required: ['type', 'id', 'fields'], properties: {
      type: { type: 'string', enum: ['strength', 'ride', 'bodyweight'] }, id: { type: 'string' },
      fields: { type: 'object', description: 'only the fields to change (same names as add_* tools)' } } } } },
  { type: 'function', function: { name: 'delete_entry',
    description: 'Delete one entry by id.',
    parameters: { type: 'object', required: ['type', 'id'], properties: {
      type: { type: 'string', enum: ['strength', 'ride', 'bodyweight'] }, id: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_statistics',
    description: 'Return computed stats: PRs/estimated 1RMs per lift, days since each lift, cycling totals and average speeds, latest bodyweight, recent volume.',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'undo_last',
    description: 'Reverse the most recent add/edit/delete. Use when the owner says that was wrong, undo that, or put it back.',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_volume',
    description: 'Total kg lifted (tonnage) over a date range, per exercise and per week.',
    parameters: { type: 'object', properties: {
      from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } } } } },
  { type: 'function', function: { name: 'get_exercise_series',
    description: 'One STRENGTH lift over time: estimated 1RM, top set and volume per session. Does not cover cycling — use get_ride_series for rides.',
    parameters: { type: 'object', required: ['exercise'], properties: {
      exercise: { type: 'string', description: 'canonical exercise key' } } } } },
  { type: 'function', function: { name: 'get_ride_series',
    description: 'Cycling over time: every ride, per-month averages, and the speed trend (improvement over time). Use for ANY bike/ride/cycling question.',
    parameters: { type: 'object', properties: {
      location: { type: 'string', enum: ['outdoors', 'indoors'], description: 'omit to include both; indoors and outdoors are not comparable' } } } } },
  { type: 'function', function: { name: 'get_recent_activity',
    description: 'Most recent training first, across lifts, rides and bodyweight, with the last training date and days since. Use for "what did I train last / recently".',
    parameters: { type: 'object', properties: {
      days: { type: 'integer', description: 'preferred window, default 30; falls back to the latest entries if the window is empty' },
      limit: { type: 'integer', description: 'max entries, default 20' } } } } },
  { type: 'function', function: { name: 'get_weekly_summary',
    description: 'This week vs last week: training days, sessions, tonnage, rides, and any PRs set this week.',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'suggest_next',
    description: 'Progressive-overload suggestion for one lift, derived from the owner\'s own last session.',
    parameters: { type: 'object', required: ['exercise'], properties: {
      exercise: { type: 'string', description: 'canonical exercise key' } } } } },
];

async function runTool(name, args) {
  switch (name) {
    case 'add_strength':   return db.addStrength(args);
    case 'add_ride':       return db.addRide(args);
    case 'add_bodyweight': return db.addBodyweight(args);
    case 'find_entries':   return db.findEntries(args);
    case 'update_entry':   return db.updateEntry(args);
    case 'delete_entry':   return db.deleteEntry(args);
    case 'get_statistics': return db.getStatistics();
    case 'undo_last':      return db.undoLast();
    case 'get_volume':     return db.getVolume(args);
    case 'get_exercise_series': return db.getExerciseSeries(args.exercise);
    case 'get_ride_series':     return db.getRideSeries(args);
    case 'get_recent_activity': return db.getRecentActivity(args);
    case 'get_weekly_summary':  return db.getWeeklySummary();
    case 'suggest_next':   return db.suggestNext(args.exercise);
    default: throw new Error(`unknown tool ${name}`);
  }
}

// Process one user message; returns { reply, changed }.
// `history` is the earlier plain user/assistant turns of this chat, oldest first — without
// it every message is answered by a model that has never seen the previous one, so
// follow-ups ("and the one before?", "make it 80kg") have nothing to refer back to.
export async function handleMessage(text, date = today(), { history = [] } = {}) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: `CURRENT DATE: ${date} (timezone ${timezone})` },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];
  let changed = false;

  for (let step = 0; step < 6; step++) {
    const res = await client.chat.completions.create({ model: MODEL, messages, tools: TOOLS, temperature: 0 });
    const msg = res.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) return { reply: msg.content?.trim() || 'Done.', changed };

    for (const call of msg.tool_calls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        result = await runTool(call.function.name, args);
        if (/^(add_|update_|delete_|undo_)/.test(call.function.name)) changed = true;
      } catch (e) {
        // Say plainly that the CALL failed. A bare error used to be indistinguishable from
        // an empty result, and got reported to the owner as "you have no data".
        result = { ok: false, error: String(e.message || e),
          hint: `The ${call.function.name} call failed — this says nothing about whether the data exists. Fix the arguments and retry, or try a different tool. Do not tell the owner they have no data.` };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { reply: 'Stopped after too many steps — please rephrase.', changed };
}
