"""Database models. See docs/architecture.md and docs/requirements.md for the rules behind them."""

import enum
import uuid
from datetime import datetime
from typing import Any

from geoalchemy2 import Geometry, WKBElement
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class GroupVisibility(enum.StrEnum):
    PUBLIC = "public"
    PRIVATE = "private"


class GroupRole(enum.StrEnum):
    ADMIN = "admin"
    MEMBER = "member"


class TrailVisibility(enum.StrEnum):
    PUBLIC = "public"
    PRIVATE = "private"
    GROUP = "group"


class TrailSource(enum.StrEnum):
    OSM = "osm"
    MANUAL = "manual"
    # A route the user loaded, for example from a GPX or KML file.
    FILE = "file"


class ElevationSource(enum.StrEnum):
    # The Copernicus DEM, which needs attribution.
    DEM = "dem"
    # The heights in the route the user loaded.
    FILE = "file"


class InvitationStatus(enum.StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    REVOKED = "revoked"


class JoinRequestStatus(enum.StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


def _enum(enum_cls: type[enum.StrEnum], name: str) -> Enum:
    return Enum(
        enum_cls,
        name=name,
        native_enum=False,
        create_constraint=True,
        length=16,
        values_callable=lambda cls: [member.value for member in cls],
    )


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # The Hanko user ID (the token's `sub` claim).
    auth_subject: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    country: Mapped[str | None] = mapped_column(String(2))
    city: Mapped[str | None] = mapped_column(String(100))
    # Reserved for future avatar support: nullable and unused in the MVP.
    avatar_url: Mapped[str | None] = mapped_column(String(2048))
    # NULL until the frontend stored the language the user first saw.
    locale: Mapped[str | None] = mapped_column(String(10))
    created_at: Mapped[datetime] = _created_at()


class Group(Base):
    __tablename__ = "groups"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[GroupVisibility] = mapped_column(
        _enum(GroupVisibility, "group_visibility"), nullable=False
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = _created_at()

    memberships: Mapped[list["GroupMembership"]] = relationship(
        back_populates="group", cascade="all, delete-orphan", passive_deletes=True
    )
    guests: Mapped[list["GroupGuest"]] = relationship(
        back_populates="group", cascade="all, delete-orphan", passive_deletes=True
    )


class GroupMembership(Base):
    __tablename__ = "group_memberships"

    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role: Mapped[GroupRole] = mapped_column(_enum(GroupRole, "group_role"), nullable=False)
    joined_at: Mapped[datetime] = _created_at()

    group: Mapped[Group] = relationship(back_populates="memberships")
    user: Mapped[User] = relationship()


class GroupGuest(Base):
    """A person identified only by a nickname. Never linked to a user account."""

    __tablename__ = "group_guests"
    __table_args__ = (UniqueConstraint("group_id", "nickname"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    nickname: Mapped[str] = mapped_column(String(100), nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    group: Mapped[Group] = relationship(back_populates="guests")


class GroupInvitation(Base):
    __tablename__ = "group_invitations"
    __table_args__ = (
        Index(
            "uq_group_invitations_pending",
            "group_id",
            text("lower(email)"),
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    # Only the SHA-256 hash is stored. The token itself exists only in the e-mailed link.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    status: Mapped[InvitationStatus] = mapped_column(
        _enum(InvitationStatus, "invitation_status"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = _created_at()


class JoinRequest(Base):
    __tablename__ = "join_requests"
    __table_args__ = (
        Index(
            "uq_join_requests_pending",
            "group_id",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    group_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[JoinRequestStatus] = mapped_column(
        _enum(JoinRequestStatus, "join_request_status"), nullable=False
    )
    created_at: Mapped[datetime] = _created_at()


class Trail(Base):
    """A route. Always owned by a user; group visibility only shares it with a group."""

    __tablename__ = "trails"
    __table_args__ = (
        CheckConstraint(
            "(visibility = 'group') = (group_id IS NOT NULL)", name="group_id_matches_visibility"
        ),
        CheckConstraint("distance_m >= 0", name="distance_not_negative"),
        Index(
            "uq_trails_public_name",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("visibility = 'public'"),
        ),
        Index(
            "uq_trails_private_name",
            "owner_user_id",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("visibility = 'private'"),
        ),
        Index(
            "uq_trails_group_name",
            "group_id",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("visibility = 'group'"),
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    visibility: Mapped[TrailVisibility] = mapped_column(
        _enum(TrailVisibility, "trail_visibility"), nullable=False
    )
    # NULL only after the owner deleted their account and the trail had to stay for others.
    owner_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    # No ON DELETE action: deleting a group must first make its shared trails private.
    group_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("groups.id"), index=True)
    source: Mapped[TrailSource] = mapped_column(_enum(TrailSource, "trail_source"), nullable=False)
    osm_relation_id: Mapped[int | None] = mapped_column(BigInteger, index=True)
    distance_m: Mapped[int] = mapped_column(Integer, nullable=False)
    # NULL for imported trails outside the available elevation data.
    elevation_gain_m: Mapped[int | None] = mapped_column(Integer)
    elevation_loss_m: Mapped[int | None] = mapped_column(Integer)
    highest_point_m: Mapped[int | None] = mapped_column(Integer)
    # Where the elevation figures came from. NULL when typed in, or when there are none.
    elevation_source: Mapped[ElevationSource | None] = mapped_column(
        _enum(ElevationSource, "elevation_source")
    )
    geometry: Mapped[WKBElement | None] = mapped_column(
        Geometry("LINESTRING", srid=4326, spatial_index=True)
    )
    # List of [distance_m, elevation_m] pairs.
    elevation_profile: Mapped[list[Any] | None] = mapped_column(JSONB)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Hike(Base):
    """One completed walk of a trail. `group_id` is NULL for personal hikes and after the
    group was deleted; attendees decide whose statistics it counts in."""

    __tablename__ = "hikes"
    __table_args__ = (CheckConstraint("duration_s > 0", name="duration_positive"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    # Trails are archived, never deleted, so a referenced trail must stay.
    trail_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("trails.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    group_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("groups.id", ondelete="SET NULL"), index=True
    )
    recorded_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    start_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    duration_s: Mapped[int] = mapped_column(Integer, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    trail: Mapped[Trail] = relationship()
    attendees: Mapped[list["HikeAttendee"]] = relationship(
        back_populates="hike", cascade="all, delete-orphan", passive_deletes=True
    )


class HikeAttendee(Base):
    __tablename__ = "hike_attendees"
    __table_args__ = (
        CheckConstraint("num_nonnulls(user_id, guest_id) = 1", name="exactly_one_attendee"),
        Index(
            "uq_hike_attendees_user",
            "hike_id",
            "user_id",
            unique=True,
            postgresql_where=text("user_id IS NOT NULL"),
        ),
        Index(
            "uq_hike_attendees_guest",
            "hike_id",
            "guest_id",
            unique=True,
            postgresql_where=text("guest_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    hike_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("hikes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    guest_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("group_guests.id", ondelete="CASCADE"), index=True
    )

    hike: Mapped[Hike] = relationship(back_populates="attendees")
    user: Mapped[User | None] = relationship()
    guest: Mapped[GroupGuest | None] = relationship()
