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

Put Copernicus GLO-30 DEM GeoTIFF files in `data/dem/` (or the directory set by `DEM_DIR`).
They are mounted read-only into the backend and are not stored in git.

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
