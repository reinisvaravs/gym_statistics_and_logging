// All "what day is it" questions go through here. Node's toISOString() is UTC, which
// puts a late-evening workout on the next day for anyone east of Greenwich.

import { config } from './config.js';

const TZ = config.timezone;

// Local calendar date as YYYY-MM-DD. `at` defaults to now.
export function today(at = new Date()) {
  // en-CA formats as YYYY-MM-DD, which is exactly what the DB wants.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(at);
}

// Shift a YYYY-MM-DD date string by whole days. addDays('2026-07-27', -7).
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Whole days between two YYYY-MM-DD strings (b - a).
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// Monday of the week containing `date`, as YYYY-MM-DD.
export function weekStart(date) {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;   // Mon=0
  return addDays(date, -dow);
}

export const timezone = TZ;
