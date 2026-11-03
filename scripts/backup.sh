#!/usr/bin/env bash
# Dumps the database to BACKUP_DIR and removes dumps older than BACKUP_KEEP_DAYS.
# With BACKUP_REMOTE set (rsync target, e.g. u123@u123.your-storagebox.de:trailstat),
# it also copies the dumps off-site. A failed copy fails the script, so cron reports it.
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
target="$BACKUP_DIR/trailstat-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$target.partial"
trap 'rm -f "$partial"' EXIT

# Custom format: compressed, and restorable with pg_restore. Written under a temporary name,
# so an interrupted run never looks like a complete backup.
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$partial"

# pg_restore reads the table of contents, which proves that the dump is a complete archive.
docker compose exec -T db pg_restore --list <"$partial" >/dev/null
chmod 600 "$partial"
mv "$partial" "$target"
echo "Backup written: $target ($(du -h "$target" | cut -f1))"

find "$BACKUP_DIR" -name 'trailstat-*.dump' -type f -mtime "+$BACKUP_KEEP_DAYS" -delete

if [ -n "$BACKUP_REMOTE" ]; then
  rsync -a --delete --include='trailstat-*.dump' --exclude='*' "$BACKUP_DIR/" "$BACKUP_REMOTE/"
  echo "Copied off-site: $BACKUP_REMOTE"
fi
