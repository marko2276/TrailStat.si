"""Statistics, computed in SQL.

Distance and elevation come from the trail, time from the hike. Each total counts a hike once:
group totals never join `hike_attendees`, and the attendee queries are safe because an attendee
appears at most once per hike. Archived trails count.
"""

import uuid
from typing import Any

from fastapi import APIRouter
from sqlalchemy import Row, func, select
from sqlalchemy.orm import Session

from app.api.hikes import StartFrom, StartTo, period_clauses
from app.auth import CurrentUser, DbSession
from app.models import GroupGuest, Hike, HikeAttendee, Trail, User
from app.permissions import get_visible_group, require_member
from app.schemas.stats import AttendeeTotals, GroupStats, Totals

router = APIRouter(prefix="/stats", tags=["stats"])

_TOTALS_COLUMNS = (
    func.count(Hike.id).label("hike_count"),
    func.coalesce(func.sum(Trail.distance_m), 0).label("total_distance_m"),
    # A trail outside the available elevation data counts as 0.
    func.coalesce(func.sum(Trail.elevation_gain_m), 0).label("total_elevation_gain_m"),
    func.coalesce(func.sum(Hike.duration_s), 0).label("total_duration_s"),
    func.coalesce(func.avg(Hike.duration_s), 0).label("average_duration_s"),
)


def _to_totals(row: Row[Any]) -> Totals:
    return Totals(
        hike_count=row.hike_count,
        total_distance_m=row.total_distance_m,
        total_elevation_gain_m=row.total_elevation_gain_m,
        total_duration_s=row.total_duration_s,
        average_duration_s=float(row.average_duration_s),
    )


def _group_totals(session: Session, where: list[Any]) -> Totals:
    query = select(*_TOTALS_COLUMNS).select_from(Hike).join(Trail, Hike.trail_id == Trail.id)
    return _to_totals(session.execute(query.where(*where)).one())


@router.get("/me", response_model=Totals)
def my_stats(
    user: CurrentUser, session: DbSession, start_from: StartFrom = None, start_to: StartTo = None
) -> object:
    """Hikes the user attended. Recording a hike for others doesn't count."""
    attended = select(HikeAttendee.hike_id).where(HikeAttendee.user_id == user.id)
    return _group_totals(session, [Hike.id.in_(attended), *period_clauses(start_from, start_to)])


@router.get("/groups/{group_id}/summary", response_model=Totals)
def group_summary(group_id: uuid.UUID, user: CurrentUser, session: DbSession) -> object:
    """What non-members of a public group may see: totals, without hikes or attendees."""
    get_visible_group(session, group_id, user)
    return _group_totals(session, [Hike.group_id == group_id])


@router.get("/groups/{group_id}", response_model=GroupStats)
def group_stats(
    group_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    start_from: StartFrom = None,
    start_to: StartTo = None,
) -> object:
    require_member(session, group_id, user)
    where = [Hike.group_id == group_id, *period_clauses(start_from, start_to)]

    name = func.coalesce(User.display_name, GroupGuest.nickname).label("name")
    rows = session.execute(
        select(HikeAttendee.user_id, HikeAttendee.guest_id, name, *_TOTALS_COLUMNS)
        .select_from(HikeAttendee)
        .join(Hike, HikeAttendee.hike_id == Hike.id)
        .join(Trail, Hike.trail_id == Trail.id)
        .outerjoin(User, HikeAttendee.user_id == User.id)
        .outerjoin(GroupGuest, HikeAttendee.guest_id == GroupGuest.id)
        .where(*where)
        .group_by(
            HikeAttendee.user_id, HikeAttendee.guest_id, User.display_name, GroupGuest.nickname
        )
        .order_by(name, HikeAttendee.user_id, HikeAttendee.guest_id)
    ).all()
    return GroupStats(
        totals=_group_totals(session, where),
        attendees=[
            AttendeeTotals(
                user_id=row.user_id, guest_id=row.guest_id, name=row.name, totals=_to_totals(row)
            )
            for row in rows
        ],
    )
