"""The admin page, for the people in ADMIN_USER_IDS. Read-only, and totals only: who signed up or
what they wrote is not shown here.

To everyone else these endpoints do not exist (404), so the page does not advertise itself.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import Select, func, select, text
from sqlalchemy.orm import Session

from app.auth import CurrentUser, DbSession
from app.config import get_settings
from app.errors import ApiError
from app.models import (
    Group,
    GroupGuest,
    GroupInvitation,
    GroupMembership,
    Hike,
    InvitationStatus,
    JoinRequest,
    JoinRequestStatus,
    Trail,
    User,
)
from app.schemas.admin import (
    AdminStats,
    ContentTotals,
    DatabaseTotals,
    ElevationData,
    ServerStatus,
    TableSize,
    UserTotals,
)

router = APIRouter(prefix="/admin", tags=["admin"])

STARTED_AT = datetime.now(UTC)
LARGEST_TABLES = 8


def require_admin(user: CurrentUser) -> User:
    if user.auth_subject not in get_settings().admin_subjects:
        raise ApiError(404, "not_found")
    return user


Admin = Annotated[User, Depends(require_admin)]


def _count(session: Session, query: Select[Any]) -> int:
    return session.scalar(select(func.count()).select_from(query.subquery())) or 0


def _grouped(session: Session, column: Any) -> dict[str, int]:
    rows = session.execute(select(column, func.count()).group_by(column)).all()
    return {str(key) if key is not None else "unknown": count for key, count in rows}


def _users(session: Session, now: datetime) -> UserTotals:
    today = now.date()
    return UserTotals(
        total=_count(session, select(User.id)),
        new_7_days=_count(session, select(User.id).where(User.created_at >= now - timedelta(7))),
        new_30_days=_count(session, select(User.id).where(User.created_at >= now - timedelta(30))),
        active_30_days=_count(
            session, select(User.id).where(User.last_seen_on > today - timedelta(30))
        ),
        by_language=_grouped(session, User.locale),
    )


def _content(session: Session, now: datetime) -> ContentTotals:
    return ContentTotals(
        trails=_count(session, select(Trail.id)),
        trails_by_source=_grouped(session, Trail.source),
        trails_by_visibility=_grouped(session, Trail.visibility),
        trails_archived=_count(session, select(Trail.id).where(Trail.archived_at.is_not(None))),
        hikes=_count(session, select(Hike.id)),
        hikes_30_days=_count(session, select(Hike.id).where(Hike.start_at >= now - timedelta(30))),
        groups=_count(session, select(Group.id)),
        memberships=_count(session, select(GroupMembership.user_id)),
        guests=_count(session, select(GroupGuest.id)),
        pending_invitations=_count(
            session,
            select(GroupInvitation.id).where(GroupInvitation.status == InvitationStatus.PENDING),
        ),
        pending_join_requests=_count(
            session,
            select(JoinRequest.id).where(JoinRequest.status == JoinRequestStatus.PENDING),
        ),
    )


def _database(session: Session) -> DatabaseTotals:
    size = session.scalar(text("SELECT pg_database_size(current_database())")) or 0
    tables = session.execute(
        text(
            "SELECT c.relname, pg_total_relation_size(c.oid), greatest(c.reltuples, 0)::bigint "
            "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE c.relkind = 'r' AND n.nspname = 'public' "
            "ORDER BY 2 DESC LIMIT :limit"
        ),
        {"limit": LARGEST_TABLES},
    ).all()
    migration = session.scalar(text("SELECT version_num FROM alembic_version"))
    return DatabaseTotals(
        size_bytes=size,
        largest_tables=[
            TableSize(name=name, size_bytes=table_size, rows_estimate=rows)
            for name, table_size, rows in tables
        ],
        migration=migration,
    )


def _elevation_data(dem_dir: str) -> ElevationData:
    directory = Path(dem_dir)
    # The same files the elevation service reads.
    files = (
        [path for path in (*directory.rglob("*.tif"), *directory.rglob("*.tiff")) if path.is_file()]
        if directory.is_dir()
        else []
    )
    return ElevationData(tiles=len(files), size_bytes=sum(path.stat().st_size for path in files))


@router.get("/stats")
def admin_stats(_: Admin, session: DbSession) -> AdminStats:
    settings = get_settings()
    now = datetime.now(UTC)
    return AdminStats(
        users=_users(session, now),
        content=_content(session, now),
        database=_database(session),
        server=ServerStatus(
            version=settings.app_version,
            environment=settings.environment,
            started_at=STARTED_AT,
            today=now.date(),
            elevation_data=_elevation_data(settings.dem_dir),
            email_configured=bool(settings.smtp_host.strip()),
            donations_bank_transfer=settings.donation_payee is not None,
            donations_flik=settings.donation_flik_number_display is not None,
        ),
    )
