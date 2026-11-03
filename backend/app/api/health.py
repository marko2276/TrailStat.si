import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.db import get_session

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
def liveness() -> dict[str, str]:
    """The API process is running."""
    return {"status": "ok"}


@router.get("/ready")
def readiness(session: Annotated[Session, Depends(get_session)]) -> dict[str, str]:
    """The database is reachable and PostGIS is available."""
    try:
        session.execute(text("SELECT postgis_version()"))
    except SQLAlchemyError as exc:
        logger.exception("Readiness check failed")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database unavailable"
        ) from exc
    return {"status": "ok"}
