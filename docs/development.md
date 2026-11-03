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

Database migrations run automatically on start (the `migrate` service).

The Hanko API URL comes from `HANKO_API_URL` in `.env`, or from
`HANKO_TRAILSTAT_SANDBOX_API` in your `.envrc`. With an `.envrc`, run `direnv allow` once.

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
