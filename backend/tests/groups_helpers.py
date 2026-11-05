"""Building blocks for the groups tests."""

import re
from collections.abc import Iterable
from datetime import UTC, datetime
from email.message import EmailMessage

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


def make_group(
    session: Session,
    *,
    name: str = "Hikers",
    visibility: GroupVisibility = GroupVisibility.PRIVATE,
    description: str | None = "Secret description",
    admins: Iterable[User] = (),
    members: Iterable[User] = (),
) -> Group:
    group = Group(name=name, description=description, visibility=visibility)
    session.add(group)
    session.flush()
    for user in admins:
        session.add(GroupMembership(group_id=group.id, user_id=user.id, role=GroupRole.ADMIN))
    for user in members:
        session.add(GroupMembership(group_id=group.id, user_id=user.id, role=GroupRole.MEMBER))
    session.commit()
    return group


def make_guest(session: Session, group: Group, nickname: str = "Uncle Bob") -> GroupGuest:
    guest = GroupGuest(group_id=group.id, nickname=nickname)
    session.add(guest)
    session.commit()
    return guest


def make_trail(
    session: Session,
    owner: User | None,
    name: str,
    visibility: TrailVisibility = TrailVisibility.PRIVATE,
    group: Group | None = None,
) -> Trail:
    trail = Trail(
        name=name,
        visibility=visibility,
        owner_user_id=owner.id if owner else None,
        group_id=group.id if group else None,
        source=TrailSource.MANUAL,
        distance_m=1000,
    )
    session.add(trail)
    session.commit()
    return trail


def make_hike(
    session: Session,
    trail: Trail,
    group: Group | None,
    users: Iterable[User] = (),
    guests: Iterable[GroupGuest] = (),
) -> Hike:
    hike = Hike(
        trail_id=trail.id,
        group_id=group.id if group else None,
        start_at=datetime(2026, 5, 1, 8, tzinfo=UTC),
        duration_s=3600,
    )
    session.add(hike)
    session.flush()
    for user in users:
        session.add(HikeAttendee(hike_id=hike.id, user_id=user.id))
    for guest in guests:
        session.add(HikeAttendee(hike_id=hike.id, guest_id=guest.id))
    session.commit()
    return hike


def body_of(message: EmailMessage) -> str:
    return message.get_content()  # type: ignore[no-any-return]


def token_in(message: EmailMessage) -> str:
    match = re.search(r"/invitations/([\w-]+)", body_of(message))
    assert match, "no invitation link in the message"
    return match.group(1)
