from fastapi import APIRouter, FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api import admin, donations, groups, health, hikes, me, stats, trails
from app.config import Settings, get_settings

api = APIRouter(prefix="/api")
api.include_router(health.router)
api.include_router(me.router)
api.include_router(trails.router)
api.include_router(hikes.router)
api.include_router(hikes.group_router)
api.include_router(groups.router)
api.include_router(stats.router)
api.include_router(donations.router)
api.include_router(admin.router)


async def validation_error(request: Request, exc: Exception) -> JSONResponse:
    """Like FastAPI's own, without echoing the invalid values. JSON has no NaN or infinity, so
    echoing one, sent as a number Python's parser accepts, would turn this 422 into a 500."""
    assert isinstance(exc, RequestValidationError)
    errors = [
        {key: value for key, value in error.items() if key not in ("input", "ctx")}
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})


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
    application.add_exception_handler(RequestValidationError, validation_error)
    application.include_router(api)
    return application


app = create_app(get_settings())
