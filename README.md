# Gym tracker

Log workouts by messaging a Telegram bot; view training and statistics on a private web dashboard.

- **Telegram bot** — send plain language ("bench 70x10 75x8 today", "delete my last squat",
  "what's my bench PR?"). An LLM turns messages into add/edit/delete/read operations.
- **Web dashboard** — strength progression, cycling speed/distance/heart-rate, bodyweight,
  and training-cadence stats. Password-protected, single user.
- **Postgres** — one source of truth. Works with Supabase or Render Postgres.

## Stack

Node + Express · OpenAI (function calling) · Telegram Bot API (webhook) · PostgreSQL · plain-HTML charts.

```
src/
  server.js     Express app: auth, data API, Telegram webhook, static
  db.js         Postgres pool + all CRUD + stats + frontend-shaped read
  ai.js         OpenAI tool-calling loop over the CRUD functions
  telegram.js   webhook + message handling, restricted to one user
  auth.js       single-user login via signed session cookie
  schema.sql    tables
public/
  index.html    dashboard (charts)
  login.html    sign-in
scripts/
  seed.js           import an existing gym.json into the DB
  hash-password.js  generate the AUTH_PASSWORD_HASH
```

## Configuration

Copy `.env.example` to `.env` and fill it in. Every value is documented there. Summary:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase or Render) |
| `OPENAI_API_KEY` | OpenAI key; `OPENAI_MODEL` defaults to `gpt-4o-mini` |
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
4. Deploy. On boot the app creates its tables, seeds from `gym.json` if the DB is empty,
   and registers the Telegram webhook automatically.

Using **Supabase** for the database instead: remove the `databases` block from
`render.yaml` and set `DATABASE_URL` to your Supabase connection string.

## Data & privacy

- Secrets live only in environment variables — never in the repo. `.env` is gitignored.
- The bot ignores every Telegram account except `ALLOWED_TELEGRAM_USER_ID`.
- The dashboard is behind a login; the data API returns nothing without a valid session.
- `gym.json` / `gym.md` are seed/reference data. Delete them if you'd rather not ship
  sample training numbers in a public repo — the app reads from the database, not these files.
