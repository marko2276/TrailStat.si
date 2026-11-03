#!/usr/bin/env bash
# End-to-end tests: real browsers, desktop and phone, against the production build of the whole
# stack, with its own throwaway database. Hanko is replaced by a stand-in (see e2e/mock-hanko).
# Extra arguments go to Playwright, e.g. scripts/e2e.sh tests/hikes.spec.ts --project=phone
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-trailstat-e2e}"
export COMPOSE_FILE=compose.yaml:e2e/compose.e2e.yaml
export POSTGRES_PASSWORD=e2e-only
export HANKO_API_URL=
export SITE_ADDRESS=http://localhost
export E2E_APP_PORT="${E2E_APP_PORT:-18080}"
export E2E_HANKO_PORT="${E2E_HANKO_PORT:-14000}"
export HTTP_PORT="$E2E_APP_PORT"
export HTTPS_PORT="${E2E_HTTPS_PORT:-18443}"
trap 'docker compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

docker compose up -d --build --wait db backend frontend caddy mock-hanko

docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e E2E_APP_PORT -e E2E_HANKO_PORT -e CI="${CI:-}" \
  -v "$PWD/e2e:/e2e" -w /e2e mcr.microsoft.com/playwright:v1.50.0-noble \
  sh -c 'npm ci --no-audit --no-fund >/dev/null && npx playwright test "$@"' -- "$@"
