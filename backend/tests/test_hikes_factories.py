"""Rows for hike and statistics tests, created directly with the models."""

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from app.models import (
    Group,
    GroupGuest,
    GroupMembership,
    GroupRole,
    GroupVisibility,
    Hike,
    HikeAttendee,
    Trail,
    TrailSource,
    TrailVisibility,
    User,
)

PAST = datetime(2026, 1, 15, 9, 0, tzinfo=UTC)


def make_group(
    session: Session,
    admin: User,
    members: Iterable[User] = (),
    visibility: GroupVisibility = GroupVisibility.PRIVATE,
) -> Group:
    group = Group(name=f"Group {uuid.uuid4().hex[:8]}", visibility=visibility)
    session.add(group)
    session.flush()
    session.add(GroupMembership(group_id=group.id, user_id=admin.id, role=GroupRole.ADMIN))
    for member in members:
        session.add(GroupMembership(group_id=group.id, user_id=member.id, role=GroupRole.MEMBER))
    session.commit()
    return group


def make_guest(session: Session, group: Group, nickname: str = "Guest") -> GroupGuest:
    guest = GroupGuest(group_id=group.id, nickname=nickname)
    session.add(guest)
    session.commit()
    return guest


def remove_member(session: Session, group: Group, user: User) -> None:
    session.execute(
        delete(GroupMembership).where(
            GroupMembership.group_id == group.id, GroupMembership.user_id == user.id
        )
    )
    session.commit()
    session.expire_all()


def make_trail(
    session: Session,
    owner: User,
    visibility: TrailVisibility = TrailVisibility.PUBLIC,
    group: Group | None = None,
    distance_m: int = 10_000,
    elevation_gain_m: int | None = 500,
    archived: bool = False,
) -> Trail:
    trail = Trail(
        name=f"Trail {uuid.uuid4().hex[:8]}",
        visibility=visibility,
        owner_user_id=owner.id,
        group_id=group.id if group is not None else None,
        source=TrailSource.MANUAL,
        distance_m=distance_m,
        elevation_gain_m=elevation_gain_m,
        archived_at=PAST if archived else None,
    )
    session.add(trail)
    session.commit()
    return trail


def make_hike(
    session: Session,
    trail: Trail,
    recorded_by: User,
    group: Group | None = None,
    users: Iterable[User] = (),
    guests: Iterable[GroupGuest] = (),
    start_at: datetime = PAST,
    duration_s: int = 3600,
) -> Hike:
    hike = Hike(
        trail_id=trail.id,
        group_id=group.id if group is not None else None,
        recorded_by=recorded_by.id,
        start_at=start_at,
        duration_s=duration_s,
    )
    hike.attendees = [HikeAttendee(user_id=user.id) for user in users] + [
        HikeAttendee(guest_id=guest.id) for guest in guests
    ]
    session.add(hike)
    session.commit()
    return hike


def delete_group(session: Session, group: Group) -> None:
    """What deleting a group does: its shared trails become private, then the database sets
    `hikes.group_id` to NULL and removes the guests and their attendance."""
    session.execute(
        update(Trail)
        .where(Trail.group_id == group.id)
        .values(group_id=None, visibility=TrailVisibility.PRIVATE)
    )
    session.execute(delete(Group).where(Group.id == group.id))
    session.commit()
    session.expire_all()
