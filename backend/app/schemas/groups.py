import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.models import GroupRole, GroupVisibility, InvitationStatus, JoinRequestStatus
from app.schemas.common import ApiModel


class GroupOut(ApiModel):
    """For non-members of a public group, `description` and `member_count` are null."""

    id: uuid.UUID
    name: str
    description: str | None
    visibility: GroupVisibility
    is_member: bool
    is_admin: bool
    member_count: int | None


class GroupCreate(BaseModel):
    # Lengths and blanks are checked in the endpoint, to report a translatable code.
    name: str
    description: str | None = None
    visibility: GroupVisibility = GroupVisibility.PRIVATE


class GroupUpdate(BaseModel):
    """Only fields present in the request change."""

    name: str | None = None
    description: str | None = None
    visibility: GroupVisibility | None = None


class MemberOut(ApiModel):
    user_id: uuid.UUID
    display_name: str
    role: GroupRole


class MemberList(BaseModel):
    items: list[MemberOut]


class MemberUpdate(BaseModel):
    role: GroupRole


class GuestOut(ApiModel):
    id: uuid.UUID
    nickname: str


class GuestList(BaseModel):
    items: list[GuestOut]


class GuestWrite(BaseModel):
    nickname: str


class InvitationCreate(BaseModel):
    email: str


class InvitationOut(ApiModel):
    """For admins. The token is never part of it: it exists only in the e-mailed link."""

    id: uuid.UUID
    email: str
    status: InvitationStatus
    expires_at: datetime
    expired: bool
    created_at: datetime


class InvitationView(BaseModel):
    """What the holder of a link sees. Group details only for the person it was sent to, so a
    forwarded link does not reveal them. `email_matches` means the address is the invited one
    and is verified. `email_verified` is false only if it is the invited one but not verified,
    so that the page can say what to do."""

    email_matches: bool
    email_verified: bool
    group_id: uuid.UUID | None
    group_name: str | None
    inviter_name: str | None
    expires_at: datetime


class JoinRequestOut(ApiModel):
    id: uuid.UUID
    user_id: uuid.UUID
    display_name: str
    status: JoinRequestStatus
    created_at: datetime


class MyJoinRequest(BaseModel):
    id: uuid.UUID | None
    status: Literal["none", "pending", "approved", "rejected"]
    created_at: datetime | None
