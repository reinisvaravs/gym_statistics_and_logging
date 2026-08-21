# Environment reference

`.env.example` and `.env` list **only the variables that must be set**. Everything else
has a working default in `src/config.js` and is deliberately absent from the env files -
a variable set to its own default is noise that hides the handful that actually matter.

This file is the record of what those defaults are, so nothing is hidden - just not
repeated in every environment.

## Required - these are in the env files

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `production` on the VPS, `development` locally |
| `PUBLIC_URL` | Public HTTPS origin. Empty locally, so no webhook is registered |
| `DATABASE_URL` | Postgres connection string |
| `AUTH_USERNAME` | Dashboard login |
| `AUTH_PASSWORD_HASH` | bcrypt hash - `node scripts/hash-password.js "password"` |
| `SESSION_SECRET` | Signs the session cookie. Min 32 chars, mandatory in production |
| `OPENAI_API_KEY` | Required whenever the bot is enabled |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Min 16 chars. The webhook's only defence |
| `ALLOWED_TELEGRAM_USER_ID` | Mandatory in production |
| `DIGEST_ENABLED` | Default is `false`, so it is listed to keep it on |

## Defaulted - set one of these only to change it

Add the variable to **both** `.env.example` and `.env` if you ever need to override it,
and move its row up into the table above.

### Network

| Variable | Default | Why the default is right |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Caddy is the only process facing the internet. Setting `0.0.0.0` publishes the app directly and bypasses the proxy |
| `PORT` | `8731` | This project's port on the shared box. Each side project gets its own |
| `TRUST_PROXY_HOPS` | `1` in production, `0` in development | Exactly one proxy (Caddy). **Becomes `2` if Cloudflare is ever put in front.** Too high and a client can spoof its own IP through `X-Forwarded-For`, defeating the rate limiter and the fail2ban jail |

### Database

| Variable | Default | Why the default is right |
| --- | --- | --- |
| `DATABASE_CA_CERT` | empty | Only needed for a remote database whose CA is not in the system trust store. TLS itself is derived from the host in `DATABASE_URL`: loopback connects without it, anything remote must present a certificate that verifies. There is deliberately **no** way to disable verification on a remote database |

### Auth and rate limiting

| Variable | Default | Why the default is right |
| --- | --- | --- |
| `SESSION_MAX_AGE_DAYS` | `30` | Single user, private dashboard |
| `RATE_LIMIT_LOGIN_ATTEMPTS` | `8` | One person, one browser. More than this is guessing |
| `RATE_LIMIT_LOGIN_WINDOW_MINUTES` | `15` | |
| `RATE_LIMIT_API_REQUESTS` | `600` | Comfortably above what the dashboard issues on load |
| `RATE_LIMIT_API_WINDOW_MINUTES` | `5` | |

### Behaviour

| Variable | Default | Why the default is right |
| --- | --- | --- |
| `TIMEZONE` | `Europe/Riga` | Decides what "today" means for a late-night session |
| `OPENAI_MODEL` | `gpt-4o-mini` | |
| `OPENAI_VISION_MODEL` | `gpt-4o-mini` | Reads bike computers and machine displays |
| `OPENAI_TRANSCRIBE_MODEL` | `whisper-1` | Voice notes |
| `CHAT_HISTORY_TURNS` | `20` | Enough for a follow-up without crowding out tool results |
| `CHAT_HISTORY_RETENTION_DAYS` | `90` | Pruned on boot so the table cannot grow without bound. Training data is never pruned |
| `DIGEST_HOUR` | `19` | Local hour, per `TIMEZONE` |
| `DIGEST_WEEKLY_DAY` | `0` | Sunday recap; other days get the short nudge |
| `LOG_LEVEL` | `info` in production, `debug` in development | |
| `SEED_ON_EMPTY` | `false` in production, `true` in development | On a server, an empty database after a failed restore must not silently refill with stale data and hide the real problem |

### Strava import - optional, not used by the server

Only `scripts/import-strava.js` reads these. Set them in the shell when running the
script rather than adding them to a deployed environment that never uses them:

```bash
STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... STRAVA_REFRESH_TOKEN=... \
  node scripts/import-strava.js
```

| Variable | Default |
| --- | --- |
| `STRAVA_CLIENT_ID` | empty |
| `STRAVA_CLIENT_SECRET` | empty |
| `STRAVA_REFRESH_TOKEN` | empty |
