from fastapi import APIRouter, FastAPI

from app.api import health

api = APIRouter(prefix="/api")
api.include_router(health.router)

app = FastAPI(
    title="TrailStat API",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)
app.include_router(api)
