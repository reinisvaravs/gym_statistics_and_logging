# Gym tracker

Log workouts by messaging a Telegram bot; view training and statistics on a private web dashboard.

- **Telegram bot** — send plain language ("bench 70x10 75x8 today", "delete my last squat",
  "what's my bench PR?"). An LLM turns messages into add/edit/delete/read operations.
  You can also send a **voice note** or a **photo** of a bike computer or machine display.
  It remembers the conversation, so follow-ups ("make it 8 reps", "and the one before?")
  work; `/reset` clears the thread without touching your training data.
- **It talks back** — an optional digest pushes a weekly recap, nudges for lifts that have
  fallen out of rotation, and a next-session suggestion built from your own history.
- **Web dashboard** — two tabs. *Charts*: strength progression, estimated 1RM over time, weekly
  volume, cycling speed/distance/heart-rate, bodyweight, training cadence. *Training log*: every
  entry exactly as saved, grouped by day and filterable by date, type or text. Entries can be
  added and edited from either. Password-protected, single user.
- **Postgres** — one source of truth. Works with Supabase or Render Postgres.

## Stack

Node + Express · OpenAI (function calling, vision, transcription) · Telegram Bot API (webhook)
· PostgreSQL · plain-HTML charts.

```
src/
  server.js     Express app: auth, data API, write API, Telegram webhook, static
  db.js         Postgres pool + all CRUD + stats/volume/suggestions + frontend-shaped read
  ai.js         OpenAI tool-calling loop over the CRUD functions
  telegram.js   webhook + message handling, restricted to one user
  media.js      photo and voice notes -> text, so they take the normal path
  digest.js     weekly recap, staleness nudges, next-session suggestion + scheduler
  strava.js     Strava API client and ride mapping
  time.js       timezone-aware "what day is it" (never use toISOString for a date)
  auth.js       single-user login via signed session cookie
  schema.sql    tables, including the audit log that makes undo possible
public/
  index.html    dashboard (charts tab + training-log tab + add/edit form)
  login.html    sign-in
scripts/
  seed.js           import an existing gym.json into the DB
  import-strava.js  import rides from Strava
  hash-password.js  generate the AUTH_PASSWORD_HASH
```

## What you can log

Strength sets carry reps plus, optionally, weight, an RPE, and assisted reps. **Bodyweight
exercises are first class**: "pull-ups 9 reps" logs with no weight at all, and "pull-ups +10kg
x6" records the added load — they are charted by reps rather than kg, and their estimated 1RM
uses your latest scale reading as the load. Sessions can also carry a free-text note.

Every add, edit and delete is journalled, so "undo that" reverses the last change.

## Configuration

Copy `.env.example` to `.env` and fill it in. Every value is documented there. Summary:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase or Render) |
| `TIMEZONE` | IANA name, default `Europe/Riga`. Decides what "today" means |
| `OPENAI_API_KEY` | OpenAI key; `OPENAI_MODEL` defaults to `gpt-4o-mini` |
| `OPENAI_VISION_MODEL` / `OPENAI_TRANSCRIBE_MODEL` | read photos / transcribe voice notes |
| `DIGEST_ENABLED` | `true` turns on the pushed recap and nudges (off by default) |
| `DIGEST_HOUR` / `DIGEST_WEEKLY_DAY` | when it sends; default 19:00 local, Sunday recap |
| `STRAVA_*` | optional, only for `scripts/import-strava.js` |
| `TELEGRAM_BOT_TOKEN` | from [@BotFather](https://t.me/botfather) |
| `TELEGRAM_WEBHOOK_SECRET` | random string; rejects forged webhook calls |
| `ALLOWED_TELEGRAM_USER_ID` | only this Telegram user may use the bot |
| `AUTH_USERNAME` / `AUTH_PASSWORD_HASH` | dashboard login (hash via the script below) |
| `SESSION_SECRET` | signs the login cookie |
| `PUBLIC_URL` | your deployed URL (auto-detected on Render) |

Generate the password hash:

```bash
node scripts/hash-password.js "your password"   # paste the output into AUTH_PASSWORD_HASH
```

Find your Telegram user id: leave `ALLOWED_TELEGRAM_USER_ID` empty, message the bot once,
and it replies with your id. Put it in the env and redeploy.

## Run locally

Needs a Postgres to point at (a Supabase database works fine from your machine).

```bash
npm install
cp .env.example .env         # then edit it
# for a local Postgres without TLS, set DATABASE_NO_SSL=true in .env
npm run seed                 # optional: import gym.json
npm start                    # http://localhost:8731
```

The Telegram webhook only registers when a public URL is set, so local runs serve the
dashboard without the bot. To exercise the bot locally, expose the port with a tunnel
(e.g. cloudflared/ngrok) and set `PUBLIC_URL` to the tunnel URL.

## Deploy (Render)

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → select the repo. `render.yaml` provisions the web
   service and a Postgres database.
3. In the service's **Environment** tab, set the secrets marked `sync: false`
   (OpenAI key, bot token, webhook secret, allowed user id, auth username + hash).
4. Deploy. On boot the app creates its tables and registers the Telegram webhook. It
   starts with an empty database — add trainings via the bot, or seed existing history
   (below).

Using **Supabase** for the database instead: remove the `databases` block from
`render.yaml` and set `DATABASE_URL` to your Supabase connection string.

### Seeding existing history (optional)

Training records are **not** in this repo (see privacy below). To load a local
`gym.json` into your live database, run the seeder from your machine pointed at the
production connection string:

```bash
DATABASE_URL="<your Supabase/Render URL>" node scripts/seed.js path/to/gym.json
```

### Importing rides from Strava

1. Create an API application at <https://www.strava.com/settings/api>. The "Authorization
   Callback Domain" can be `localhost`. Copy the **Client ID** and **Client Secret**.
2. Open this URL in a browser (replacing `CLIENT_ID`) and click Authorize:
   `https://www.strava.com/oauth/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=http://localhost/exchange_token&approval_prompt=force&scope=activity:read_all`
   The scope must be `activity:read_all` — plain `activity:read` hides activities you
   marked private.
3. The browser lands on a broken `localhost` page whose URL contains `?code=XXXX`. Exchange
   that code for tokens:
   ```bash
   curl -X POST https://www.strava.com/api/v3/oauth/token \
     -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \
     -d code=XXXX -d grant_type=authorization_code
   ```
4. Put the client id, secret and the returned `refresh_token` into `.env` as
   `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`.

```bash
npm run import:strava                                  # last 90 days
node scripts/import-strava.js --after=2026-01-01 --dry-run
```

Re-running is safe: a ride on the same date with the same distance (±0.2km) and duration
(±1min) is skipped. Strava rotates the refresh token periodically; when it does, the script
prints the new value — paste it back into your env.

## The digest

Set `DIGEST_ENABLED=true` and the bot messages you instead of only answering. On the weekly
day it sends a recap (training days, tonnage vs last week, PRs); on other days it stays quiet
unless a lift has gone stale. Staleness is judged against each lift's *own* rhythm, so
benching every three weeks doesn't get nagged weekly, and during a real layoff it sends one
line a week rather than every day.

## Data & privacy

- Secrets live only in environment variables — never in the repo. `.env` is gitignored.
- Personal training data (`gym.json`, `gym.md`) is gitignored and never published; the app
  reads from the database, not these files.
- The bot ignores every Telegram account except `ALLOWED_TELEGRAM_USER_ID`.
- The dashboard is behind a login; the data API returns nothing without a valid session.
