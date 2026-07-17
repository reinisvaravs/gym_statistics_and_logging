// Import an existing gym.json into the database. Runs automatically on first boot
// (when the DB is empty), or manually:  node scripts/seed.js [path-to-gym.json]
import 'dotenv/config';
import fs from 'node:fs';
import * as db from '../src/db.js';

export async function seedFromFile(file) {
  if (!fs.existsSync(file)) return 0;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;

  for (const ex of data.strength || []) {
    for (const s of ex.sessions || []) {
      await db.addStrength({ date: s.d, exercise: ex.key, exerciseName: ex.name,
        sets: s.sets.map(x => ({ weightKg: x.w, reps: x.r, assistedReps: x.a || 0 })) });
      n++;
    }
  }
  for (const r of data.rides || []) {
    await db.addRide({ date: r.d, location: r.loc === 'out' ? 'outdoors' : 'indoors',
      durationMin: r.min, distanceKm: r.km, speedKmh: r.kmh, avgHr: r.bpm, avgWatts: r.w, avgCadence: r.rpm, note: r.note });
    n++;
  }
  for (const b of data.bodyweight || []) { await db.addBodyweight({ date: b.d, weightKg: b.kg }); n++; }
  return n;
}

// run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] || new URL('../gym.json', import.meta.url).pathname;
  await db.initSchema();
  const n = await seedFromFile(file);
  console.log(`Seeded ${n} entries from ${file}`);
  process.exit(0);
}
