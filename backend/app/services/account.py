"""Exporting and deleting a user's account (GDPR)."""

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, exists, func, select, update
from sqlalchemy.orm import Session, selectinload

from app.api.groups import remove_group
from app.models import (
    Group,
    GroupInvitation,
    GroupMembership,
    GroupRole,
    Hike,
    HikeAttendee,
    Trail,
    TrailVisibility,
    User,
)


def export_account(session: Session, user: User) -> dict[str, Any]:
    """Everything stored about the user. Other people's names are not theirs to export."""
    trails = session.execute(
        select(Trail, func.ST_AsGeoJSON(Trail.geometry))
        .where(Trail.owner_user_id == user.id)
        .order_by(Trail.created_at)
    ).all()
    hikes = session.scalars(
        select(Hike)
        .join(HikeAttendee, HikeAttendee.hike_id == Hike.id)
        .where(HikeAttendee.user_id == user.id)
        .options(selectinload(Hike.trail))
        .order_by(Hike.start_at)
    ).all()
    group_names = dict(
        session.execute(
            select(Group.id, Group.name).where(
                Group.id.in_({hike.group_id for hike in hikes if hike.group_id})
            )
        )
        .tuples()
        .all()
    )
    groups = session.execute(
        select(Group.name, GroupMembership.role, GroupMembership.joined_at)
        .join(GroupMembership, GroupMembership.group_id == Group.id)
        .where(GroupMembership.user_id == user.id)
        .order_by(Group.name)
    ).all()
    return {
        "exported_at": datetime.now(UTC).isoformat(),
        "profile": {
            "email": user.email,
            "display_name": user.display_name,
            "country": user.country,
            "city": user.city,
            "locale": user.locale,
            "created_at": user.created_at.isoformat(),
        },
        "trails": [
            {
                "name": trail.name,
                "description": trail.description,
                "visibility": trail.visibility.value,
                "source": trail.source.value,
                "osm_relation_id": trail.osm_relation_id,
                "distance_m": trail.distance_m,
                "elevation_gain_m": trail.elevation_gain_m,
                "elevation_loss_m": trail.elevation_loss_m,
                "highest_point_m": trail.highest_point_m,
                "geometry": json.loads(geometry) if geometry else None,
                "archived": trail.archived_at is not None,
                "created_at": trail.created_at.isoformat(),
            }
            for trail, geometry in trails
        ],
        "hikes": [
            {
                "trail": hike.trail.name,
                "distance_m": hike.trail.distance_m,
                "elevation_gain_m": hike.trail.elevation_gain_m,
                "start_at": hike.start_at.isoformat(),
                "duration_s": hike.duration_s,
                "notes": hike.notes,
                "group": group_names.get(hike.group_id) if hike.group_id else None,
            }
            for hike in hikes
        ],
        "groups": [
            {"name": name, "role": role.value, "joined_at": joined_at.isoformat()}
            for name, role, joined_at in groups
        ],
    }


def _hand_over_groups(session: Session, user: User) -> None:
    """A group always keeps an admin. Deleting an account must always be possible, so the
    longest-standing member takes over from a last admin, and a group with no one else goes."""
    group_ids = session.scalars(
        select(GroupMembership.group_id)
        .where(GroupMembership.user_id == user.id, GroupMembership.role == GroupRole.ADMIN)
        .order_by(GroupMembership.group_id)  # A consistent lock order prevents deadlocks.
    ).all()
    for group_id in group_ids:
        group = session.scalar(select(Group).where(Group.id == group_id).with_for_update())
        if group is None:
            continue
        others = session.scalars(
            select(GroupMembership)
            .where(GroupMembership.group_id == group_id, GroupMembership.user_id != user.id)
            .order_by(GroupMembership.joined_at, GroupMembership.user_id)
        ).all()
        if not others:
            remove_group(session, group)
        elif all(member.role != GroupRole.ADMIN for member in others):
            others[0].role = GroupRole.ADMIN
    session.flush()


def delete_account(session: Session, user: User) -> None:
    """Removes the user's personal data, in one transaction, without committing."""
    _hand_over_groups(session, user)

    # Hikes only this user attended would be left with nobody. Others keep their hikes, without
    # this user's name: their attendance goes with the account, through the foreign key.
    attended = exists().where(HikeAttendee.hike_id == Hike.id, HikeAttendee.user_id == user.id)
    attended_by_others = exists().where(
        HikeAttendee.hike_id == Hike.id,
        (HikeAttendee.user_id.is_(None)) | (HikeAttendee.user_id != user.id),
    )
    session.execute(
        delete(Hike)
        .where(attended, ~attended_by_others)
        .execution_options(synchronize_session=False)
    )

    # Private trails go, except where someone else's hike refers to one: possible when it was
    # public or shared before. It stays hidden, with only what their hikes show.
    in_use = exists().where(Hike.trail_id == Trail.id)
    session.execute(
        delete(Trail)
        .where(
            Trail.owner_user_id == user.id,
            Trail.visibility == TrailVisibility.PRIVATE,
            ~in_use,
        )
        .execution_options(synchronize_session=False)
    )
    session.execute(
        update(Trail)
        .where(Trail.owner_user_id == user.id, Trail.visibility == TrailVisibility.PRIVATE)
        .values(description=None)
        .execution_options(synchronize_session=False)
    )

    # Invitations hold the address too, and may have been sent before the account existed.
    session.execute(
        delete(GroupInvitation)
        .where(func.lower(GroupInvitation.email) == user.email.lower())
        .execution_options(synchronize_session=False)
    )
    # Foreign keys handle the rest: memberships, attendance and join requests go; shared and
    # public trails stay without an owner, since others may rely on them.
    session.delete(user)
