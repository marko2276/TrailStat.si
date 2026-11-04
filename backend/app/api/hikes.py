"""Hikes. The rules are in docs/requirements.md, section 4.

Someone who attended a group hike and has left the group keeps it in their history, but only
their own part of it: what the group keeps private, they no longer see.

A hike without a group is either a personal hike, or a group hike whose group was deleted. Both
follow one rule: it belongs to its attendees. Only a sole attendee can edit it, and "delete"
removes the caller's own attendance, so one person's removal doesn't erase others' history.
"""

import uuid
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Query, Response
from pydantic import AwareDatetime
from sqlalchemy import ColumnElement, Select, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from app.auth import CurrentUser, DbSession
from app.errors import ApiError
from app.models import (
    Group,
    GroupGuest,
    GroupMembership,
    GroupRole,
    Hike,
    HikeAttendee,
    TrailVisibility,
    User,
)
from app.permissions import get_membership, get_visible_trail, require_member
from app.schemas.common import Page
from app.schemas.hikes import HikeAttendeeRead, HikeCreate, HikeRead, HikeTrail, HikeUpdate

router = APIRouter(prefix="/hikes", tags=["hikes"])
group_router = APIRouter(prefix="/groups", tags=["hikes"])

# Clocks differ slightly between a phone and the server.
FUTURE_TOLERANCE = timedelta(minutes=5)
EARLIEST_START = datetime(1900, 1, 1, tzinfo=UTC)

StartFrom = Annotated[AwareDatetime | None, Query(description="Inclusive")]
StartTo = Annotated[AwareDatetime | None, Query(description="Exclusive")]
Limit = Annotated[int, Query(ge=1, le=200)]
Offset = Annotated[int, Query(ge=0)]


def period_clauses(start_from: datetime | None, start_to: datetime | None) -> list[Any]:
    """`start_from` is inclusive and `start_to` exclusive, so periods can follow each other."""
    clauses: list[ColumnElement[bool]] = []
    if start_from is not None:
        clauses.append(Hike.start_at >= start_from)
    if start_to is not None:
        clauses.append(Hike.start_at < start_to)
    return clauses


def _hike_query() -> Select[Hike]:
    return select(Hike).options(
        joinedload(Hike.trail),
        selectinload(Hike.attendees).options(
            joinedload(HikeAttendee.user), joinedload(HikeAttendee.guest)
        ),
    )


def _is_attendee(hike: Hike, user: User) -> bool:
    return any(attendee.user_id == user.id for attendee in hike.attendees)


def _get_visible_hike(
    session: Session, hike_id: uuid.UUID, user: User, *, lock: bool = False
) -> Hike:
    """Attendees, including those who left the group, and members of the hike's group.

    Changing a hike takes the lock, before checking anything: its attendees are then read after
    the lock is granted. Otherwise two edits, each removing other attendees, or two attendees
    removing themselves, could both pass the "someone stays" check and leave nobody."""
    query = _hike_query().where(Hike.id == hike_id).execution_options(populate_existing=True)
    if lock:
        query = query.with_for_update(of=Hike)
    hike = session.scalar(query)
    if hike is None or not (
        _is_attendee(hike, user)
        or (hike.group_id is not None and get_membership(session, hike.group_id, user) is not None)
    ):
        raise ApiError(404, "not_found")
    return hike


def _can_edit(hike: Hike, user: User, role: GroupRole | None) -> bool:
    if hike.group_id is not None:
        return role == GroupRole.ADMIN or (role is not None and hike.recorded_by == user.id)
    return len(hike.attendees) == 1 and _is_attendee(hike, user)


def _can_delete(hike: Hike, user: User, role: GroupRole | None) -> bool:
    if hike.group_id is not None:
        return role == GroupRole.ADMIN
    return _is_attendee(hike, user)


def _role_in_group(session: Session, hike: Hike, user: User) -> GroupRole | None:
    if hike.group_id is None:
        return None
    membership = get_membership(session, hike.group_id, user)
    return membership.role if membership is not None else None


def _attendee_read(attendee: HikeAttendee) -> HikeAttendeeRead:
    if attendee.user is not None:
        name = attendee.user.display_name
    else:
        assert attendee.guest is not None  # a database constraint guarantees one of the two
        name = attendee.guest.nickname
    return HikeAttendeeRead(user_id=attendee.user_id, guest_id=attendee.guest_id, name=name)


def _serialize(session: Session, hikes: Sequence[Hike], user: User) -> list[HikeRead]:
    """Reads group names and the user's roles once for all hikes, not per hike."""
    group_ids = {hike.group_id for hike in hikes if hike.group_id is not None}
    names: dict[uuid.UUID, str] = {}
    roles: dict[uuid.UUID, GroupRole] = {}
    if group_ids:
        names = {
            row.id: row.name
            for row in session.execute(select(Group.id, Group.name).where(Group.id.in_(group_ids)))
        }
        roles = {
            row.group_id: row.role
            for row in session.execute(
                select(GroupMembership.group_id, GroupMembership.role).where(
                    GroupMembership.user_id == user.id, GroupMembership.group_id.in_(group_ids)
                )
            )
        }

    result = []
    for hike in hikes:
        role = roles.get(hike.group_id) if hike.group_id is not None else None
        trail = HikeTrail(
            id=hike.trail.id,
            name=hike.trail.name,
            distance_m=hike.trail.distance_m,
            elevation_gain_m=hike.trail.elevation_gain_m,
            archived=hike.trail.archived_at is not None,
        )
        if hike.group_id is not None and role is None:
            # Only attendees get here, or they could not see the hike: they have left the group.
            result.append(
                HikeRead(
                    id=hike.id,
                    trail=trail,
                    group_id=None,
                    group_name=None,
                    recorded_by=None,
                    start_at=hike.start_at,
                    duration_s=hike.duration_s,
                    notes=None,
                    attendees=[
                        _attendee_read(attendee)
                        for attendee in hike.attendees
                        if attendee.user_id == user.id
                    ],
                    can_edit=False,
                    can_delete=False,
                )
            )
            continue
        attendees = sorted(
            (_attendee_read(attendee) for attendee in hike.attendees),
            key=lambda attendee: attendee.name.casefold(),
        )
        result.append(
            HikeRead(
                id=hike.id,
                trail=trail,
                group_id=hike.group_id,
                group_name=names.get(hike.group_id) if hike.group_id is not None else None,
                recorded_by=hike.recorded_by,
                start_at=hike.start_at,
                duration_s=hike.duration_s,
                notes=hike.notes,
                attendees=attendees,
                can_edit=_can_edit(hike, user, role),
                can_delete=_can_delete(hike, user, role),
            )
        )
    return result


def _read_page(
    session: Session, where: list[Any], user: User, limit: int, offset: int
) -> Page[HikeRead]:
    total = session.scalar(select(func.count()).select_from(Hike).where(*where)) or 0
    hikes = session.scalars(
        _hike_query()
        .where(*where)
        .order_by(Hike.start_at.desc(), Hike.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    items = _serialize(session, hikes, user)
    return Page[HikeRead](items=items, total=total, limit=limit, offset=offset)


def _read_one(session: Session, hike_id: uuid.UUID, user: User) -> HikeRead:
    return _serialize(session, [_get_visible_hike(session, hike_id, user)], user)[0]


def _check_start_at(start_at: datetime) -> None:
    if start_at > datetime.now(UTC) + FUTURE_TOLERANCE:
        raise ApiError(422, "start_at_in_future")
    if start_at < EARLIEST_START:
        raise ApiError(422, "start_at_too_old")


def _check_new_trail(
    session: Session, trail_id: uuid.UUID, user: User, group_id: uuid.UUID | None
) -> None:
    """The rules for choosing a trail. A hike already on a trail isn't subject to them, so it
    stays editable after its trail is archived."""
    trail = get_visible_trail(session, trail_id, user)
    if trail.archived_at is not None:
        raise ApiError(422, "trail_archived")
    # The recorder seeing the trail isn't enough: every member must be able to see the hike's.
    if group_id is not None and not (
        trail.visibility == TrailVisibility.PUBLIC
        or (trail.visibility == TrailVisibility.GROUP and trail.group_id == group_id)
    ):
        raise ApiError(422, "trail_not_visible_to_group")


def _check_new_group_attendees(
    session: Session,
    group_id: uuid.UUID,
    user_ids: Iterable[uuid.UUID],
    guest_ids: Iterable[uuid.UUID],
) -> None:
    wanted_users = set(user_ids)
    wanted_guests = set(guest_ids)
    if wanted_users:
        members = session.scalars(
            select(GroupMembership.user_id).where(
                GroupMembership.group_id == group_id, GroupMembership.user_id.in_(wanted_users)
            )
        )
        if wanted_users - set(members):
            raise ApiError(422, "attendee_not_member")
    if wanted_guests:
        guests = session.scalars(
            select(GroupGuest.id).where(
                GroupGuest.group_id == group_id, GroupGuest.id.in_(wanted_guests)
            )
        )
        if wanted_guests - set(guests):
            raise ApiError(422, "guest_not_in_group")


def _check_personal_attendees(
    user: User, user_ids: Iterable[uuid.UUID], guest_ids: Iterable[uuid.UUID]
) -> None:
    if set(user_ids) - {user.id} or set(guest_ids):
        raise ApiError(422, "personal_hike_attendees")


def _apply_group_attendees(
    session: Session,
    hike: Hike,
    user_ids: list[uuid.UUID] | None,
    guest_ids: list[uuid.UUID] | None,
) -> None:
    """Replaces the attendees. Only those newly added must be current members, so people who
    have since left stay valid on the hike."""
    current_users = {a.user_id for a in hike.attendees if a.user_id is not None}
    current_guests = {a.guest_id for a in hike.attendees if a.guest_id is not None}
    new_users = current_users if user_ids is None else set(user_ids)
    new_guests = current_guests if guest_ids is None else set(guest_ids)
    if not new_users and not new_guests:
        raise ApiError(422, "attendees_required")

    assert hike.group_id is not None
    _check_new_group_attendees(
        session, hike.group_id, new_users - current_users, new_guests - current_guests
    )
    hike.attendees = [
        attendee
        for attendee in hike.attendees
        if attendee.user_id in new_users or attendee.guest_id in new_guests
    ]
    hike.attendees.extend(HikeAttendee(user_id=id_) for id_ in new_users - current_users)
    hike.attendees.extend(HikeAttendee(guest_id=id_) for id_ in new_guests - current_guests)


@router.get("", response_model=Page[HikeRead])
def list_my_hikes(
    user: CurrentUser,
    session: DbSession,
    start_from: StartFrom = None,
    start_to: StartTo = None,
    limit: Limit = 50,
    offset: Offset = 0,
) -> object:
    """Hikes the user attended, personal and group, newest first."""
    attended = select(HikeAttendee.hike_id).where(HikeAttendee.user_id == user.id)
    where = [Hike.id.in_(attended), *period_clauses(start_from, start_to)]
    return _read_page(session, where, user, limit, offset)


@group_router.get("/{group_id}/hikes", response_model=Page[HikeRead])
def list_group_hikes(
    group_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    start_from: StartFrom = None,
    start_to: StartTo = None,
    limit: Limit = 50,
    offset: Offset = 0,
) -> object:
    require_member(session, group_id, user)
    where = [Hike.group_id == group_id, *period_clauses(start_from, start_to)]
    return _read_page(session, where, user, limit, offset)


@router.post("", response_model=HikeRead, status_code=201)
def create_hike(body: HikeCreate, user: CurrentUser, session: DbSession) -> object:
    if body.group_id is not None:
        require_member(session, body.group_id, user)
    _check_start_at(body.start_at)
    _check_new_trail(session, body.trail_id, user, body.group_id)

    hike = Hike(
        trail_id=body.trail_id,
        group_id=body.group_id,
        recorded_by=user.id,
        start_at=body.start_at,
        duration_s=body.duration_s,
        notes=body.notes or None,
    )
    if body.group_id is None:
        _check_personal_attendees(user, body.attendee_user_ids, body.attendee_guest_ids)
        hike.attendees.append(HikeAttendee(user_id=user.id))
    else:
        _apply_group_attendees(session, hike, body.attendee_user_ids, body.attendee_guest_ids)
    session.add(hike)
    session.commit()
    return _read_one(session, hike.id, user)


@router.get("/{hike_id}", response_model=HikeRead)
def read_hike(hike_id: uuid.UUID, user: CurrentUser, session: DbSession) -> object:
    return _read_one(session, hike_id, user)


@router.patch("/{hike_id}", response_model=HikeRead)
def update_hike(
    hike_id: uuid.UUID, body: HikeUpdate, user: CurrentUser, session: DbSession
) -> object:
    hike = _get_visible_hike(session, hike_id, user, lock=True)
    if not _can_edit(hike, user, _role_in_group(session, hike, user)):
        raise ApiError(403, "forbidden")

    changes = body.model_dump(exclude_unset=True)
    for required in (
        "trail_id",
        "start_at",
        "duration_s",
        "attendee_user_ids",
        "attendee_guest_ids",
    ):
        if required in changes and changes[required] is None:
            raise ApiError(422, f"{required}_required")

    # Check everything before changing anything: a rejected edit must leave the hike untouched.
    if body.start_at is not None:
        _check_start_at(body.start_at)
    new_trail = body.trail_id is not None and body.trail_id != hike.trail_id
    if body.trail_id is not None and new_trail:
        _check_new_trail(session, body.trail_id, user, hike.group_id)
    if hike.group_id is None:
        _check_personal_attendees(user, body.attendee_user_ids or [], body.attendee_guest_ids or [])
    elif body.attendee_user_ids is not None or body.attendee_guest_ids is not None:
        _apply_group_attendees(session, hike, body.attendee_user_ids, body.attendee_guest_ids)

    if body.start_at is not None:
        hike.start_at = body.start_at
    if body.trail_id is not None and new_trail:
        hike.trail_id = body.trail_id
    if body.duration_s is not None:
        hike.duration_s = body.duration_s
    if "notes" in changes:
        hike.notes = body.notes or None

    try:
        session.commit()
    except IntegrityError as exc:
        # An attendee was added or removed by something that doesn't take the hike's lock.
        session.rollback()
        raise ApiError(409, "hike_changed") from exc
    return _read_one(session, hike.id, user)


@router.delete("/{hike_id}", status_code=204)
def delete_hike(hike_id: uuid.UUID, user: CurrentUser, session: DbSession) -> Response:
    hike = _get_visible_hike(session, hike_id, user, lock=True)
    if not _can_delete(hike, user, _role_in_group(session, hike, user)):
        raise ApiError(403, "forbidden")

    if hike.group_id is not None:
        session.delete(hike)
    else:
        hike.attendees = [attendee for attendee in hike.attendees if attendee.user_id != user.id]
        if not hike.attendees:
            session.delete(hike)
    session.commit()
    return Response(status_code=204)
