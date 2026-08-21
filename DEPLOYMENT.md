# Deploying the gym tracker to the side-projects VPS

Phase 2 of `../SERVER_SETUP.md`, and the template every later side project on this box
follows. Phase 1 (hardening) must be complete before any of this.

| | |
| --- | --- |
| **Server** | `157.180.17.94` - `ssh deploy@157.180.17.94` |
| **App user** | `gym-tracker` (system account, no login shell, owns nothing else) |
| **App dir** | `/opt/gym-tracker` |
| **Secrets** | `/etc/gym-tracker/gym-tracker.env` - `0600`, `root:gym-tracker` |
| **Listens on** | `127.0.0.1:8731` - never the public interface |
| **Public URL** | `https://gym.reinis.site` via Caddy |
| **Database** | Postgres on this box, loopback only |
| **Backups** | `/var/backups/gym-tracker`, nightly 03:30 UTC, 30 days |

> **Before you start**, decide the subdomain and create its DNS `A` record pointing at
> `157.180.17.94`. Caddy issues the certificate over ACME by being reached on port 80,
> so DNS must resolve *first*. Replace `CHANGE_ME` in `deploy/Caddyfile` with it.

---

## 1 - Packages

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib git ca-certificates curl gnupg
```

Node from NodeSource - Ubuntu's own `nodejs` package lags well behind, and this app
requires Node 20 or newer:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # expect v22.x
```

Caddy from its official repository:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 2 - Open the web ports

Phase 1 left ufw with only `22/tcp` open. Caddy needs both 80 and 443 - port 80 is not
optional, ACME validates over it and renewal fails silently without it.

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status verbose
```

## 3 - Database

```bash
sudo -u postgres createuser gym_tracker
sudo -u postgres createdb --owner=gym_tracker gym_tracker
DB_PASS="$(openssl rand -hex 24)"
sudo -u postgres psql -c "ALTER ROLE gym_tracker WITH PASSWORD '$DB_PASS';"
echo "DATABASE_URL=postgres://gym_tracker:$DB_PASS@127.0.0.1:5432/gym_tracker"
```

Copy that line - it goes into the env file in step 5.

Confirm Postgres is not listening on anything public. It should show `127.0.0.1:5432`
and nothing else:

```bash
sudo ss -tulpn | grep 5432
```

If it shows `0.0.0.0:5432`, set `listen_addresses = 'localhost'` in
`/etc/postgresql/*/main/postgresql.conf` and restart. ufw would block it anyway, but a
database should not be listening publicly in the first place.

## 4 - Service account and code

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gym-tracker
sudo mkdir -p /opt/gym-tracker
sudo chown deploy:deploy /opt/gym-tracker
git clone https://github.com/reinisvaravs/gym_tracker.git /opt/gym-tracker
cd /opt/gym-tracker
npm ci --omit=dev
```

> `npm ci`, not `npm install` - `ci` installs exactly what `package-lock.json` pins.
> `install` is free to resolve a newer version, which means the code you tested is not
> necessarily the code you deployed.

The app reads its own files and writes nothing, so it does not need to own them:

```bash
sudo chown -R root:gym-tracker /opt/gym-tracker
sudo chmod -R g+rX,o-rwx /opt/gym-tracker
```

## 5 - Secrets

```bash
sudo mkdir -p /etc/gym-tracker
sudo cp /opt/gym-tracker/.env.example /etc/gym-tracker/gym-tracker.env
sudo chown root:gym-tracker /etc/gym-tracker/gym-tracker.env
sudo chmod 0640 /etc/gym-tracker/gym-tracker.env
sudo nano /etc/gym-tracker/gym-tracker.env
```

Fill in every value. Generate the ones that must be random:

```bash
openssl rand -hex 32    # SESSION_SECRET
openssl rand -hex 32    # TELEGRAM_WEBHOOK_SECRET
node /opt/gym-tracker/scripts/hash-password.js 'your dashboard password'   # AUTH_PASSWORD_HASH
```

**Rotate every secret carried over from the laptop** - the old Supabase password, the
OpenAI key, the Telegram bot token. They sat in plaintext in a local `.env.production`
for months (that file is now deleted; its values live in the local `.env`). Moving hosts
is the natural moment to retire them.

Only the 11 variables in `.env.example` need values. Everything else is defaulted in
`src/config.js` and listed in `ENV_REFERENCE.md` - do not paste defaults back in.

This file is the **third** instance of the env file, alongside the committed
`.env.example` and the local development `.env`. All three carry the same keys in the
same order; only the values differ. When a key is added, removed or renamed, it must be
changed in all three - and this one is only reachable from the server.

`src/config.js` validates all of this at boot, so a mistake here stops the service with
a message naming the variable rather than starting something quietly broken.

## 6 - systemd

```bash
sudo cp /opt/gym-tracker/deploy/gym-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gym-tracker
systemctl status gym-tracker
journalctl -u gym-tracker -n 50 -o cat
```

A healthy first boot logs `{"level":"info","msg":"listening","host":"127.0.0.1",...}`.

Confirm the sandbox actually applied - this is the check people skip:

```bash
systemd-analyze security gym-tracker.service
```

Expect an exposure score around 2.x ("OK"). Anything above 5 means directives were
dropped or overridden.

## 7 - Caddy

```bash
sudo cp /opt/gym-tracker/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # set the real subdomain and email
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
journalctl -u caddy -n 30 -o cat      # watch the certificate being issued
```

## 8 - Telegram webhook

The app registers the webhook itself on startup once `PUBLIC_URL` is set and TLS is
live. Restart it so registration runs against the now-working certificate:

```bash
sudo systemctl restart gym-tracker
journalctl -u gym-tracker -n 20 -o cat | grep webhook
```

Confirm with Telegram directly:

```bash
source /etc/gym-tracker/gym-tracker.env
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo" | jq
```

`pending_update_count` should be 0 and `last_error_message` absent.

## 9 - Backups

```bash
sudo cp /opt/gym-tracker/deploy/backup.sh /usr/local/bin/gym-tracker-backup.sh
sudo chown root:root /usr/local/bin/gym-tracker-backup.sh
sudo chmod 0750 /usr/local/bin/gym-tracker-backup.sh
sudo cp /opt/gym-tracker/deploy/gym-tracker-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gym-tracker-backup.timer
sudo systemctl start gym-tracker-backup.service     # run once now
ls -la /var/backups/gym-tracker/
```

**Then test the restore.** An untested backup is a guess:

```bash
sudo -u postgres createdb restore_test
gunzip -c /var/backups/gym-tracker/gym-tracker-*.sql.gz | sudo -u postgres psql restore_test
sudo -u postgres psql restore_test -c 'SELECT count(*) FROM strength_sessions;'
sudo -u postgres dropdb restore_test
```

## 10 - fail2ban

The in-process rate limiter slows one connection; this bans the address at the firewall.

```bash
sudo cp /opt/gym-tracker/deploy/fail2ban/gym-tracker-auth.conf /etc/fail2ban/filter.d/
sudo cp /opt/gym-tracker/deploy/fail2ban/gym-tracker.local /etc/fail2ban/jail.d/
sudo systemctl restart fail2ban
sudo fail2ban-client status gym-tracker-auth
```

Verify the filter matches real lines rather than trusting that it loaded:

```bash
sudo fail2ban-regex "$(journalctl -u gym-tracker --since '1 hour ago' -o cat | grep login_failed | head -1)" \
  /etc/fail2ban/filter.d/gym-tracker-auth.conf
```

Zero matches means the jail is enabled and doing nothing - the same silent failure mode
as fail2ban's default `auth.log` backend on a journal-only system.

---

## Verification

```bash
# app is on loopback only - must NOT show 0.0.0.0:8731
sudo ss -tulpn | grep 8731

# only 22, 80, 443 open
sudo ufw status verbose

# TLS and headers from outside
curl -sI https://gym.reinis.site/login | grep -iE 'strict-transport|content-security|x-frame'

# health through the proxy
curl -s https://gym.reinis.site/healthz

# the dashboard refuses anonymous API access
curl -s -o /dev/null -w '%{http_code}\n' https://gym.reinis.site/api/data     # expect 401

# the webhook refuses a request without the secret
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://gym.reinis.site/telegram/webhook   # expect 401

# everything survives a reboot
for u in gym-tracker caddy postgresql fail2ban gym-tracker-backup.timer; do
  printf '%-28s ' "$u"; systemctl is-enabled "$u"; done
```

## Updating

```bash
cd /opt/gym-tracker
sudo -u deploy git pull
sudo npm ci --omit=dev
sudo systemctl restart gym-tracker
journalctl -u gym-tracker -n 30 -o cat
```

Restart is graceful: the app closes its listener, finishes in-flight requests and drains
the connection pool on SIGTERM before exiting.

## Rolling back

| To undo | Command |
| --- | --- |
| Stop the app | `sudo systemctl disable --now gym-tracker` |
| Revert to a previous commit | `cd /opt/gym-tracker && sudo -u deploy git checkout <sha> && sudo npm ci --omit=dev && sudo systemctl restart gym-tracker` |
| Remove the site from Caddy | delete its block in `/etc/caddy/Caddyfile`, `sudo systemctl reload caddy` |
| Close the web ports | `sudo ufw delete allow 80/tcp && sudo ufw delete allow 443/tcp` |
| Restore the database | `gunzip -c /var/backups/gym-tracker/<file>.sql.gz \| sudo -u postgres psql gym_tracker` |
| Unban an IP | `sudo fail2ban-client set gym-tracker-auth unbanip <IP>` |

## Traps specific to this box

- **Docker bypasses ufw.** Not used here, but if any future side project on this box
  publishes a port with Docker, it is reachable from the internet regardless of ufw.
  Bind `127.0.0.1:PORT:PORT` and let Caddy front it.
- **`MemoryDenyWriteExecute=true` breaks Node.** V8 needs write+execute pages for its
  JIT. It is the one directive from the standard systemd hardening checklist that must
  stay off - the unit file says so too.
- **`TRUST_PROXY_HOPS` must match reality exactly.** It is 1 behind Caddy alone. Set it
  too high and a client can spoof its own IP through `X-Forwarded-For`, which defeats
  both the rate limiter and the fail2ban jail.
- **RAM is the binding constraint.** The unit caps this service at 400 MB so a leak here
  gets it restarted instead of the kernel OOM-killing an unrelated project.
