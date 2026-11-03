from fastapi import APIRouter, FastAPI

from app.api import groups, health, hikes, me, stats, trails

api = APIRouter(prefix="/api")
api.include_router(health.router)
api.include_router(me.router)
api.include_router(trails.router)
api.include_router(hikes.router)
api.include_router(groups.router)
api.include_router(stats.router)

app = FastAPI(
    title="TrailStat API",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)
app.include_router(api)
