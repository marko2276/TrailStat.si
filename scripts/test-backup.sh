#!/usr/bin/env bash
# Proves the backup can be restored: backs up real rows, destroys the database, restores it,
# and checks the rows and PostGIS. Uses its own throwaway project and never the dev stack.
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=trailstat-backuptest
export COMPOSE_FILE=compose.yaml
export POSTGRES_PASSWORD=backup-test
export POSTGRES_USER=trailstat
export POSTGRES_DB=trailstat
export BACKUP_DIR="$(mktemp -d)"
export RESTORE_CONFIRM=yes
trap 'docker compose down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$BACKUP_DIR"' EXIT

sql() { docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -qAt' <<<"$1"; }
expect() {
  if [ "$2" != "$3" ]; then echo "FAILED: $1: expected '$2', got '$3'" >&2; exit 1; fi
  echo "ok: $1"
}

docker compose up -d --build --wait db >/dev/null 2>&1
docker compose up -d --wait backend >/dev/null 2>&1

sql "INSERT INTO users (id, auth_subject, email, display_name)
     VALUES ('00000000-0000-0000-0000-000000000001', 'sub', 'šmarna@example.com', 'Šmarna');
     INSERT INTO trails (id, name, visibility, owner_user_id, source, distance_m, geometry)
     VALUES ('00000000-0000-0000-0000-000000000002', 'Pot', 'public',
             '00000000-0000-0000-0000-000000000001', 'manual', 1000,
             ST_GeomFromText('LINESTRING(14 46, 14.1 46.1)', 4326));"

scripts/backup.sh
dump="$(ls "$BACKUP_DIR"/trailstat-*.dump)"
[ "$(ls "$BACKUP_DIR" | grep -c partial || true)" = 0 ] || { echo "FAILED: partial file left" >&2; exit 1; }
expect "backup file is private" 600 "$(stat -c %a "$dump")"

sql "DELETE FROM trails; DELETE FROM users; INSERT INTO users (id, auth_subject, email, display_name)
     VALUES (gen_random_uuid(), 'added-after-backup', 'x@example.com', 'x');"
expect "the data was really changed" "1" "$(sql 'SELECT count(*) FROM users')"

scripts/restore.sh "$dump"

expect "rows are back, with UTF-8 intact" "Šmarna" "$(sql 'SELECT display_name FROM users')"
expect "rows added after the backup are gone" "0" \
  "$(sql "SELECT count(*) FROM users WHERE auth_subject = 'added-after-backup'")"
expect "PostGIS geometry survived" "LINESTRING(14 46,14.1 46.1)" "$(sql 'SELECT ST_AsText(geometry) FROM trails')"
expect "migration state survived" "$(ls backend/migrations/versions | tail -1 | cut -d_ -f1)" \
  "$(sql 'SELECT version_num FROM alembic_version')"

for i in $(seq 1 20); do
  docker compose exec -T backend python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health/ready', timeout=3)" >/dev/null 2>&1 && break
  [ "$i" = 20 ] && { echo "FAILED: API not ready after restore" >&2; exit 1; }
  sleep 2
done
echo "ok: API is ready on the restored database"

corrupt="$BACKUP_DIR/corrupt.dump"
head -c 2000 /dev/urandom >"$corrupt"
if scripts/restore.sh "$corrupt" >/dev/null 2>&1; then
  echo "FAILED: a corrupt backup was accepted" >&2; exit 1
fi
expect "a corrupt backup leaves the database untouched" "Šmarna" "$(sql 'SELECT display_name FROM users')"

old="$BACKUP_DIR/trailstat-20000101T000000Z.dump"
touch -d '2000-01-01' "$old"
scripts/backup.sh >/dev/null
[ ! -e "$old" ] || { echo "FAILED: old backup not removed" >&2; exit 1; }
echo "ok: old backups are removed"

echo "== backup and restore verified"
