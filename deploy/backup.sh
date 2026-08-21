#!/usr/bin/env bash
# Nightly Postgres backup for the gym tracker.
# Install: /usr/local/bin/gym-tracker-backup.sh  (root:root, 0750)
#
# Choosing to host Postgres on the VPS means backups stopped being someone else's job.
# A database with no tested restore is not a database, it is a countdown.

set -Eeuo pipefail

DB_NAME="${DB_NAME:-gym_tracker}"
DB_USER="${DB_USER:-gym_tracker}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/gym-tracker}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

umask 077   # backups contain every row; nobody but root reads them
mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/gym-tracker-$stamp.sql.gz"

# Write to a temporary name and rename only on success. A backup file that exists but is
# a truncated dump is worse than no file, because the monitoring says it ran.
tmp="$target.partial"
trap 'rm -f "$tmp"' ERR

# -Fc would be smaller, but plain SQL can be inspected and partially recovered by hand,
# which matters more than size for a database this small.
sudo -u postgres pg_dump --no-owner --no-privileges "$DB_NAME" | gzip -9 > "$tmp"

# A valid gzip stream that ends cleanly. Catches a dump killed halfway by OOM.
gzip -t "$tmp"

# A dump of an empty database is ~2 KB of boilerplate and would quietly replace good
# backups with useless ones over the retention window.
size=$(stat -c%s "$tmp")
if [ "$size" -lt 5000 ]; then
  echo "backup is only ${size} bytes - refusing to keep it" >&2
  rm -f "$tmp"
  exit 1
fi

mv "$tmp" "$target"
echo "backup ok: $target (${size} bytes)"

# Prune old backups only after a new one has been written successfully.
find "$BACKUP_DIR" -name 'gym-tracker-*.sql.gz' -mtime "+$RETAIN_DAYS" -delete
echo "retained: $(find "$BACKUP_DIR" -name 'gym-tracker-*.sql.gz' | wc -l) files"
