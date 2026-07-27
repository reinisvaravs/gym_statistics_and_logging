# Roadmap

Improvements to make the tracker actually useful day to day. Everything below is built and
verified against a throwaway Postgres (45 data-layer assertions) and a real browser session.

## 1. Correctness — things that were wrong

- [x] **Bodyweight exercises can't be logged.** `addStrength` required a finite `weightKg`
      per set and silently dropped sets without one. Weight is now optional; a set carries
      `bw: true` meaning "bodyweight is the load, `w` is *added* kg". Their e1RM uses the
      most recent scale reading as the load, carried forward to each session date.
      Legacy rows written as 0kg self-heal: an exercise whose sets never carry a load is
      treated as bodyweight work, so its history stops charting as a flat zero.
- [x] **Dates were UTC, not local.** New `src/time.js` owns every "what day is it"
      question, driven by `TIMEZONE` (default `Europe/Riga`).
- [x] **No undo.** `audit_log` journals every insert/update/delete; `undoLast` reverses the
      most recent one and repeated calls walk backwards rather than ping-ponging. Exposed
      to the bot as an `undo_last` tool and to the dashboard as `POST /api/undo`.

## 2. Data model gaps

- [x] **RPE + notes** per set and per session.
- [x] **Volume (tonnage)** per session, per exercise and per week. Assisted reps count as
      half a rep, matching how they are written down.
- [x] **e1RM over time** via `getExerciseSeries`, charted in its own card.
- [x] **Date-ranged reads** — `assembleData({ from, to })`, wired to `/api/data`.

## 3. The bot reaches out

- [x] **Weekly recap**: training days, tonnage vs last week, rides, PRs.
- [x] **Staleness nudges**, judged against each lift's *own* median gap so a lift trained
      every three weeks isn't nagged weekly.
- [x] **Next-session suggestion** from your own last session — hold the weight and add a
      rep until the top set is strong, then add the smallest plate.
- [x] **Layoff notice**: one line a week during a real break, instead of silence.

## 4. Input ergonomics

- [x] **Photo input** — vision model reads a bike computer or machine display.
- [x] **Voice input** — transcribed, and echoed back so a mis-hearing is visible.
- [x] **Strava import** — `npm run import:strava`, idempotent on re-runs.

## 5. Dashboard

- [x] **Estimated 1RM** and **weekly volume** charts.
- [x] **Quick add/edit form**, including shorthand (`bwx13 bw+10x7 bwx9@8`) and
      edit/delete affordances on the existing data tables.

---

## Known gaps, deliberately left

- **The pull-up history in `gym.md` was never imported.** `gym.json` contains zero pull-up
  data because the old code dropped weightless sets on the floor — the bug ate it before it
  ever reached the database. The parser now supports those sets, but backfilling the old
  markdown is a separate job and hasn't been done.
- **Strava dates follow the Strava account's timezone**, not `TIMEZONE`, because
  `start_date_local` is already shifted. Only matters for late-night rides if the two ever
  disagree.
- No automated test runner in the repo. The data-layer suite lives in the scratchpad; worth
  promoting to `scripts/` with a `npm test` if this keeps growing.
