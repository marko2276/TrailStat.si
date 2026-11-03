"""Who may see what. Shared by all features, so the rules live in one place.

Something a user may not see is reported as 404, not 403, so its existence does not leak.
Use 403 when they can see it but may not perform the action.
"""

import uuid

from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.orm import Session

from app.errors import ApiError
from app.models import (
    Group,
    GroupMembership,
    GroupRole,
    GroupVisibility,
    Trail,
    TrailVisibility,
    User,
)


def get_membership(session: Session, group_id: uuid.UUID, user: User) -> GroupMembership | None:
    return session.get(GroupMembership, (group_id, user.id))


def get_visible_group(session: Session, group_id: uuid.UUID, user: User) -> Group:
    """Public groups are visible to all users, private ones to members only."""
    group = session.get(Group, group_id)
    if group is None or (
        group.visibility != GroupVisibility.PUBLIC
        and get_membership(session, group_id, user) is None
    ):
        raise ApiError(404, "not_found")
    return group


def require_member(session: Session, group_id: uuid.UUID, user: User) -> GroupMembership:
    group = get_visible_group(session, group_id, user)
    membership = get_membership(session, group.id, user)
    if membership is None:
        raise ApiError(403, "forbidden")
    return membership


def require_admin(session: Session, group_id: uuid.UUID, user: User) -> GroupMembership:
    membership = require_member(session, group_id, user)
    if membership.role != GroupRole.ADMIN:
        raise ApiError(403, "forbidden")
    return membership


def visible_trails_clause(user: User) -> ColumnElement[bool]:
    """Public trails, the user's own private trails, and trails shared with the user's groups."""
    my_groups = select(GroupMembership.group_id).where(GroupMembership.user_id == user.id)
    return or_(
        Trail.visibility == TrailVisibility.PUBLIC,
        (Trail.visibility == TrailVisibility.PRIVATE) & (Trail.owner_user_id == user.id),
        (Trail.visibility == TrailVisibility.GROUP) & Trail.group_id.in_(my_groups),
    )


def get_visible_trail(session: Session, trail_id: uuid.UUID, user: User) -> Trail:
    trail = session.scalar(select(Trail).where(Trail.id == trail_id, visible_trails_clause(user)))
    if trail is None:
        raise ApiError(404, "not_found")
    return trail


def can_edit_trail(session: Session, trail: Trail, user: User) -> bool:
    """The creator, and for trails shared with a group also that group's admins."""
    if trail.owner_user_id == user.id:
        return True
    if trail.visibility == TrailVisibility.GROUP and trail.group_id is not None:
        membership = get_membership(session, trail.group_id, user)
        return membership is not None and membership.role == GroupRole.ADMIN
    return False
