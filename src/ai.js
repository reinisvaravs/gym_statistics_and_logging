import OpenAI from 'openai';
import * as db from './db.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SYSTEM = `You are the assistant behind a personal gym-tracking Telegram bot. The owner logs
workouts and asks questions in plain language; you call tools to add, edit, delete, or read entries
in their database, then reply with a short, friendly confirmation.

Data model:
- STRENGTH sessions: a weighted lift (bench, squat, lat pulldown, deadlift, overhead press, row, ...)
  on a date, with sets. Each set has weightKg, reps, and assistedReps (reps a spotter helped finish —
  the owner writes these as a half rep, e.g. "70x7.5" = 7 reps + 1 assisted).
- RIDE: cycling, indoors or outdoors (different bikes; wind resistance outdoors). Fields: durationMin,
  distanceKm, speedKmh, avgHr, avgWatts, avgCadence, note. A plain "bike" with only a duration is indoors.
- BODYWEIGHT: an occasional scale reading in kg.

Unit rules when reading messages: "24km"=distance, "23km/h"=speed, "130bpm"=heart rate, "163W"=watts,
"84rpm"=cadence, "1h 15min"=75 minutes. Never put a measured value into a note.

Guidance:
- Resolve relative dates ("today", "yesterday") using the CURRENT DATE given to you. Format YYYY-MM-DD.
- To edit or delete, FIRST call find_entries to get the exact entry id, then call update_entry/delete_entry with that id. Never guess ids.
- Canonical exercise keys are lowercase, no spaces: bench, squat, pulldown, deadlift, ohp, row.
- Keep replies to one or two lines. Confirm what changed. If a request is ambiguous, ask a brief question instead of guessing.`;

const TOOLS = [
  { type: 'function', function: { name: 'add_strength',
    description: 'Add a weighted-lift session.',
    parameters: { type: 'object', required: ['date', 'exercise', 'sets'], properties: {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      exercise: { type: 'string', description: 'canonical key: bench, squat, pulldown, deadlift, ohp, row' },
      exerciseName: { type: 'string', description: 'display name, e.g. "Bench press"' },
      sets: { type: 'array', items: { type: 'object', required: ['weightKg', 'reps'], properties: {
        weightKg: { type: 'number' }, reps: { type: 'integer' }, assistedReps: { type: 'integer' } } } },
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
    description: 'Search existing entries. Use before editing or deleting to get the exact id.',
    parameters: { type: 'object', properties: {
      type: { type: 'string', enum: ['strength', 'ride', 'bodyweight'] },
      exercise: { type: 'string' }, dateFrom: { type: 'string' }, dateTo: { type: 'string' },
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
    description: 'Return computed stats: PRs/estimated 1RMs per lift, cycling totals and average speeds, latest bodyweight.',
    parameters: { type: 'object', properties: {} } } },
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
    default: throw new Error(`unknown tool ${name}`);
  }
}

// Process one user message; returns { reply, changed }.
export async function handleMessage(text, today) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: `CURRENT DATE: ${today}` },
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
        if (/^(add_|update_|delete_)/.test(call.function.name)) changed = true;
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { reply: 'Stopped after too many steps — please rephrase.', changed };
}
