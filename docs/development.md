# Development

Docker with the Compose plugin is the only requirement. Python and Node run in containers.

## Start the stack

```sh
cp .env.example .env          # then set POSTGRES_PASSWORD
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:5173 | App, with live reload |
| http://localhost:8000/api/docs | API documentation (off in production) |
| http://localhost:5173/api/health/ready | Readiness check through the frontend proxy |
| http://localhost:8025 | Mailpit: the inbox for all e-mail sent in development |

Database migrations run automatically on start (the `migrate` service).

The Hanko API URL comes from `HANKO_API_URL` in `.env`, or from
`HANKO_TRAILSTAT_SANDBOX_API` in your `.envrc`. With an `.envrc`, run `direnv allow` once.

## E-mail

In development the backend sends all e-mail to [Mailpit](https://mailpit.axllent.org), which
catches it: nothing leaves the machine. Read it at http://localhost:8025. In production, set
`SMTP_HOST`, the other `SMTP_*` settings and `APP_URL` in `.env`. Tests use a fake sender, the
`outbox` fixture.

Templates are in `backend/app/services/email_templates/<language>/`; the first line of each file
is the subject. To add a language, add a directory.

## Checks

```sh
# Backend (the database must be running)
docker compose run --rm backend pytest
docker compose run --rm backend ruff check .
docker compose run --rm backend ruff format --check .
docker compose run --rm backend mypy

# Frontend
docker compose run --rm frontend npm test
docker compose run --rm frontend npm run lint
docker compose run --rm frontend npm run format:check
docker compose run --rm frontend npm run typecheck
```

## Database migrations

```sh
docker compose run --rm backend alembic revision --autogenerate -m "describe the change"
docker compose run --rm backend alembic upgrade head
```

## Adding dependencies

Lockfiles are generated in containers, then rebuild the images:

```sh
docker compose run --rm --no-deps backend uv add --no-sync <package>
docker compose run --rm --no-deps frontend npm install <package>
docker compose build
```

## Production-like run

Set `COMPOSE_FILE=compose.yaml` in `.env`, then `docker compose up --build`.
The app is served by Caddy on http://localhost:8080.

## Production checklist

Set these in `.env` on the server, and use only `compose.yaml` (`COMPOSE_FILE=compose.yaml`):

- `ENVIRONMENT=production`. The backend then refuses to start, and says why, unless the next three
  are set. It also turns off `/api/docs` and `/api/openapi.json`: the docs page loads Swagger UI
  from a third-party CDN, which NFR-3 rules out. Anything but `development` or `production` is
  refused too. The default is `development`, which checks nothing.
- `HANKO_API_URL` and `HANKO_AUDIENCE`: the self-hosted Hanko (NFR-3, NFR-5) and the app's domain.
  Without an audience, tokens issued for other sites would be accepted.
- `SMTP_HOST` and the other `SMTP_*` settings: without them invitations fail, and join request
  notifications are lost with only a line in the log.
- `APP_URL`: the `https://` address of the app, for links in e-mails.
- `SITE_ADDRESS` (the bare domain, for automatic HTTPS), with `HTTP_PORT=80` and `HTTPS_PORT=443`.
- `POSTGRES_PASSWORD`, generated as `.env.example` says, and a nightly backup (see [Backups](#backups)).
- `VITE_MAP_STYLE_URL` if needed. It is read when the frontend is built.

The rate limits in `backend/app/rate_limit.py` and the limit on concurrent Overpass calls are counted
per process, so run a single backend process, as `compose.yaml` does.

## Elevation data

Trail imports read elevation from Copernicus GLO-30 DEM GeoTIFF files in `data/dem/` (or the directory
set by `DEM_DIR`). They are mounted read-only into the backend and are not stored in git.

```sh
./scripts/download-dem.sh                 # Slovenia and the nearby Alps: N45-N47, E013-E016, about 500 MB
./scripts/download-dem.sh N46_00_E013_00  # only the named tiles
```

The script needs `curl`, skips files already there, and fetches from the public `copernicus-dem-30m`
bucket. Tiles are found by their georeferencing on every import, so supporting a new region only means
putting its tiles in the directory, without a restart. Trails imported before that keep having no
elevation data.

Without a matching tile, or with any void along the route, a trail is imported with null elevation
fields and the app says so. These values are a radar surface model at 30 m, so sharp summits come out
low: Triglav (2864 m) is 2801 m at its highest pixel.

**Attribution is required** wherever these elevations are shown, and the trail page shows it:
"produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved".

## OpenStreetMap and maps

`OVERPASS_URL` sets the Overpass server, by default the public `overpass-api.de`. Be gentle with it:
tests use a mocked transport, and the app never repeats a failed query on its own. Calls are limited
to 3 at a time and 20 per user per minute. No database connection is held during them, so a slow
Overpass can't stall the rest of the API. OSM data must be credited (ODbL), and the map and every
imported trail do so.

`VITE_MAP_STYLE_URL` sets the MapLibre style, by default OpenFreeMap's `liberty`, which needs no key.
It is read at build time. Do not use openstreetmap.org's tile servers: their policy forbids it.

## Run all checks

`./scripts/check.sh` runs every linter and test in containers, against a throwaway database.
It does not touch the dev stack.

## End-to-end tests

`./scripts/e2e.sh [playwright args]` runs real browsers, desktop and phone, against the production
build through Caddy, with a throwaway database. The harness is test-only, in `e2e/`:

- `e2e/mock-hanko/server.mjs` stands in for Hanko (real signed tokens, but no sign-in screen) and
  Overpass (`backend/tests/fixtures`, with queries that choose a failure).
- Mailpit receives e-mail, and tests read the real messages through its API.
- `e2e/dem/` has a synthetic elevation tile for that route, written by `generate.py`.
- The map style is stubbed, so tests don't need the tile server.

Set `E2E_APP_PORT`, `E2E_HANKO_PORT`, `E2E_HTTPS_PORT` and `E2E_MAILPIT_PORT` to run beside something
else. Screenshots of all pages go to `e2e/screenshots/`, for looking at the layout.

Tests share a database and run in parallel, so names of public things must be unique: `unique()`.

## Code conventions

**Layout.** Each feature owns its files: backend `app/api/<feature>.py` and
`app/schemas/<feature>.py`; frontend `src/features/<feature>/` and
`src/locales/<language>/<feature>.json`. What features need from each other is in [`api.md`](api.md).

**Backend**

- Sign-in: take `user: CurrentUser` and `session: DbSession` from `app.auth`.
- Visibility and permissions: use `app.permissions`. Never repeat those rules in a query. Something
  the user may not see is a 404; something they may see but not do is a 403.
- Errors: `raise ApiError(status, "machine_code")`. The frontend translates the code.
- Lists: return `Page[T]` from `app.schemas.common`.
- Commit in the endpoint, once the whole action has succeeded.
- Changing a model needs a migration. `test_models_match_migrations` fails without one.

**Backend tests** use a real database, rolled back after every test. Fixtures in `tests/conftest.py`:
`client`, `session`, `create_user`, and `auth_headers(user)`. Test the rule, and also that the
forbidden case fails: every permission needs a test with the wrong user.

**Frontend**

- API calls: `api` and `withQuery` from `src/lib/api.ts`, through React Query.
- Text: never hard-code it. Use `useTranslation("<feature>")`; every key must exist in all languages,
  which a test enforces. Backend error codes go under `errors` in the feature's namespace, and
  are shown by `<ErrorMessage error={error} ns="<feature>" />`.
- Dates, numbers, distance, elevation and duration: `useFormat()` from `src/lib/format.ts`.
- Styling: reuse the classes in `src/styles.css`. Layouts must work at phone width.
- Changing data other features show: `invalidateSharedData` from `src/lib/sharedData.ts`.

**Frontend tests**: `render` from `src/test/render.tsx` and `mockApi` from `src/test/mockApi.ts`.
Mock `../../auth/hanko` in tests that use the API, as the existing ones do.

## Backups

```sh
scripts/backup.sh                                # to ./backups, keeping 30 days
scripts/restore.sh backups/trailstat-<time>.dump # replaces the database; asks first
scripts/test-backup.sh                           # proves the full cycle on a throwaway database
```

Configure with `BACKUP_DIR`, `BACKUP_KEEP_DAYS` and `BACKUP_REMOTE` (an rsync target). A nightly
off-site backup in the server's crontab, where `/srv/trailstat` is the checkout:

```
30 3 * * * BACKUP_REMOTE=u123@u123.your-storagebox.de:trailstat /srv/trailstat/scripts/backup.sh
```

Dumps contain personal data. Keep them private, in the EU, and test a restore regularly.
Deleted accounts remain in old dumps until they age out, which the privacy policy must state.
