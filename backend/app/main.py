from fastapi import APIRouter, FastAPI

from app.api import groups, health, hikes, me, stats, trails
from app.config import Settings, get_settings

api = APIRouter(prefix="/api")
api.include_router(health.router)
api.include_router(me.router)
api.include_router(trails.router)
api.include_router(hikes.router)
api.include_router(hikes.group_router)
api.include_router(groups.router)
api.include_router(stats.router)


def create_app(settings: Settings) -> FastAPI:
    problems = settings.production_problems()
    if problems:
        raise RuntimeError(
            f"Refusing to start with ENVIRONMENT=production: {'; '.join(problems)}. "
            "See the production checklist in docs/development.md."
        )
    # Not in production: the docs page loads Swagger UI from a third-party CDN (NFR-3).
    application = FastAPI(
        title="TrailStat API",
        version="0.1.0",
        docs_url=None if settings.is_production else "/api/docs",
        redoc_url=None,
        openapi_url=None if settings.is_production else "/api/openapi.json",
    )
    application.include_router(api)
    return application


app = create_app(get_settings())
