#!/usr/bin/env bash
# Replaces the current database with a backup. Stops the app while restoring.
# Usage: scripts/restore.sh backups/trailstat-<time>.dump
set -euo pipefail
cd "$(dirname "$0")/.."

dump="${1:?Usage: scripts/restore.sh <dump file>}"
[ -f "$dump" ] || { echo "No such file: $dump" >&2; exit 1; }

if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  read -r -p "This REPLACES the database of project '$(docker compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')' with $dump. Type 'restore' to continue: " answer
  [ "$answer" = "restore" ] || { echo "Cancelled."; exit 1; }
fi

docker compose exec -T db pg_restore --list <"$dump" >/dev/null || {
  echo "$dump is not a valid backup; the database was not changed." >&2
  exit 1
}

docker compose stop backend

# Connect to the maintenance database, because the app's database is being replaced.
docker compose exec -T db sh -c '
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)" \
    -c "CREATE DATABASE \"$POSTGRES_DB\""
'
docker compose exec -T db sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --no-owner' <"$dump"

# `up` also runs the migrations, which brings an older backup up to the current version.
docker compose up -d backend
echo "Restored from $dump."
