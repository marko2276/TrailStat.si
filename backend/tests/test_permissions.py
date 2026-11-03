import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import permissions
from app.errors import ApiError
from app.models import (
    Group,
    GroupMembership,
    GroupRole,
    GroupVisibility,
    Trail,
    TrailSource,
    TrailVisibility,
    User,
)
from tests.conftest import CreateUser


def make_group(
    session: Session,
    visibility: GroupVisibility = GroupVisibility.PRIVATE,
    members: dict[User, GroupRole] | None = None,
) -> Group:
    group = Group(name="Group", visibility=visibility)
    session.add(group)
    session.flush()
    for user, role in (members or {}).items():
        session.add(GroupMembership(group_id=group.id, user_id=user.id, role=role))
    session.commit()
    return group


def make_trail(
    session: Session, owner: User, visibility: TrailVisibility, group: Group | None = None
) -> Trail:
    trail = Trail(
        name=f"Trail {uuid.uuid4().hex}",
        visibility=visibility,
        owner_user_id=owner.id,
        group_id=group.id if group else None,
        source=TrailSource.MANUAL,
        distance_m=1000,
    )
    session.add(trail)
    session.commit()
    return trail


def visible_ids(session: Session, user: User) -> set[uuid.UUID]:
    return set(session.scalars(select(Trail.id).where(permissions.visible_trails_clause(user))))


def test_private_group_is_hidden_from_non_members(
    session: Session, create_user: CreateUser
) -> None:
    group = make_group(session)

    with pytest.raises(ApiError) as error:
        permissions.get_visible_group(session, group.id, create_user())

    assert error.value.status_code == 404


def test_public_group_is_visible_but_acting_needs_membership(
    session: Session, create_user: CreateUser
) -> None:
    group = make_group(session, GroupVisibility.PUBLIC)
    outsider = create_user()

    assert permissions.get_visible_group(session, group.id, outsider).id == group.id
    with pytest.raises(ApiError) as error:
        permissions.require_member(session, group.id, outsider)
    assert error.value.status_code == 403


def test_require_admin(session: Session, create_user: CreateUser) -> None:
    admin, member = create_user(), create_user()
    group = make_group(session, members={admin: GroupRole.ADMIN, member: GroupRole.MEMBER})

    assert permissions.require_admin(session, group.id, admin).user_id == admin.id
    with pytest.raises(ApiError) as error:
        permissions.require_admin(session, group.id, member)
    assert error.value.status_code == 403


def test_trail_visibility_rules(session: Session, create_user: CreateUser) -> None:
    owner, member, outsider = create_user(), create_user(), create_user()
    group = make_group(session, members={owner: GroupRole.ADMIN, member: GroupRole.MEMBER})
    public = make_trail(session, owner, TrailVisibility.PUBLIC)
    private = make_trail(session, owner, TrailVisibility.PRIVATE)
    shared = make_trail(session, owner, TrailVisibility.GROUP, group)

    assert {public.id, private.id, shared.id} <= visible_ids(session, owner)
    assert {public.id, shared.id} <= visible_ids(session, member)
    assert private.id not in visible_ids(session, member)
    assert public.id in visible_ids(session, outsider)
    assert not {private.id, shared.id} & visible_ids(session, outsider)

    with pytest.raises(ApiError) as error:
        permissions.get_visible_trail(session, private.id, outsider)
    assert error.value.status_code == 404


def test_trail_edit_rules(session: Session, create_user: CreateUser) -> None:
    owner, admin, member, other = create_user(), create_user(), create_user(), create_user()
    group = make_group(
        session,
        members={owner: GroupRole.MEMBER, admin: GroupRole.ADMIN, member: GroupRole.MEMBER},
    )
    public = make_trail(session, owner, TrailVisibility.PUBLIC)
    shared = make_trail(session, owner, TrailVisibility.GROUP, group)

    assert permissions.can_edit_trail(session, public, owner)
    assert not permissions.can_edit_trail(session, public, other)
    # An admin of some group has no say over a public trail.
    assert not permissions.can_edit_trail(session, public, admin)
    assert permissions.can_edit_trail(session, shared, owner)
    assert permissions.can_edit_trail(session, shared, admin)
    assert not permissions.can_edit_trail(session, shared, member)
