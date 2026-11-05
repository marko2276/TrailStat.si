#!/usr/bin/env bash
# Runs every test and linter in containers. Used locally and by CI.
# Uses its own throwaway database. It never touches the dev stack, and several checkouts can
# run side by side if each sets a different COMPOSE_PROJECT_NAME.
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-trailstat-check}"
export POSTGRES_PASSWORD=check-only
compose=(docker compose -f compose.yaml -f compose.dev.yaml)
trap '"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
backend() { "${compose[@]}" run --rm -T backend "$@"; }
frontend() { "${compose[@]}" run --rm -T --no-deps frontend "$@"; }

"${compose[@]}" build backend frontend

echo "== backend"
backend ruff check .
backend ruff format --check .
backend mypy
backend alembic check
backend pytest -q

echo "== frontend"
frontend npm run lint
frontend npm run format:check
frontend npm run typecheck
frontend npm test

echo "== production images"
docker compose -f compose.yaml build

echo "== all checks passed"
