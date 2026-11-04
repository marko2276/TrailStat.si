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
| http://localhost:8000/api/docs | API documentation |
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
tests use a mocked transport, and the app never repeats a failed query on its own. OSM data must be
credited (ODbL), and the map and every imported trail do so.

`VITE_MAP_STYLE_URL` sets the MapLibre style, by default OpenFreeMap's `liberty`, which needs no key.
It is read at build time. Do not use openstreetmap.org's tile servers: their policy forbids it.

## Run all checks

`./scripts/check.sh` runs every linter and test in containers, against a throwaway database.
It does not touch the dev stack.

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
