// Import cycling rides from Strava into the database.
//   node scripts/import-strava.js [--after=YYYY-MM-DD] [--before=YYYY-MM-DD] [--dry-run]
// Defaults to the last 90 days. Rides already in the DB (same date, same distance and
// duration) are skipped, so re-running is safe.
import 'dotenv/config';
import * as db from '../src/db.js';
import { importRides } from '../src/strava.js';
import { today, addDays } from '../src/time.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseArgs(argv) {
  const get = name => argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  const after = get('after') || addDays(today(), -90);
  const before = get('before') || today();
  for (const [flag, v] of [['after', after], ['before', before]]) {
    if (!DATE_RE.test(v)) throw new Error(`--${flag} must be YYYY-MM-DD (got "${v}")`);
  }
  return { after, before, dryRun: argv.includes('--dry-run') };
}

const fmt = r => [
  r.date,
  r.location === 'indoors' ? 'in ' : 'out',
  r.distanceKm != null ? `${r.distanceKm}km` : '—',
  r.durationMin != null ? `${r.durationMin}min` : '—',
  r.speedKmh != null ? `${r.speedKmh}km/h` : '',
  r.note ? `"${r.note}"` : '',
].filter(Boolean).join('  ');

// run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { after, before, dryRun } = parseArgs(process.argv.slice(2));
    await db.initSchema();
    console.log(`Strava import ${after} → ${before}${dryRun ? '  (dry run — nothing written)' : ''}`);

    const { imported, skipped, rides, newRefreshToken } = await importRides({ after, before, dryRun });
    for (const r of rides) console.log(`  ${r.status === 'skipped' ? 'skip  ' : 'import'}  ${fmt(r)}`);
    console.log(`\n${imported} ${dryRun ? 'would be imported' : 'imported'}, ${skipped} skipped (already in DB).`);

    // Strava rotates the refresh token — tell the user before the next run fails.
    if (newRefreshToken) console.log(`\nStrava issued a new refresh token. Update your env:\n  STRAVA_REFRESH_TOKEN=${newRefreshToken}`);
    process.exit(0);
  } catch (e) {
    console.error(`Strava import failed: ${e.message}`);
    process.exit(1);
  }
}
