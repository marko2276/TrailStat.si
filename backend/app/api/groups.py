"""Groups: membership, invitations, join requests and guests. Rules in docs/requirements.md."""

import hashlib
import logging
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Query
from sqlalchemy import ColumnElement, delete, exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app import permissions
from app.auth import CurrentUser, DbSession, VerifiedEmail
from app.config import get_settings
from app.errors import ApiError
from app.models import (
    Group,
    GroupGuest,
    GroupInvitation,
    GroupMembership,
    GroupRole,
    GroupVisibility,
    Hike,
    HikeAttendee,
    InvitationStatus,
    JoinRequest,
    JoinRequestStatus,
    Trail,
    TrailVisibility,
    User,
)
from app.rate_limit import INVITATION_EMAILS, JOIN_REQUESTS, enforce
from app.schemas.common import MAX_OFFSET, Page
from app.schemas.groups import (
    GroupCreate,
    GroupOut,
    GroupUpdate,
    GuestList,
    GuestOut,
    GuestWrite,
    InvitationCreate,
    InvitationOut,
    InvitationView,
    JoinRequestOut,
    MemberList,
    MemberOut,
    MemberUpdate,
    MyJoinRequest,
)
from app.services.email import (
    EmailError,
    EmailSender,
    Mailer,
    invitation_email,
    join_request_email,
    one_line,
    pick_locale,
    send_best_effort,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/groups", tags=["groups"])

INVITATION_VALID_DAYS = 7
MAX_GROUP_NAME = 100
MAX_DESCRIPTION = 2000
MAX_NICKNAME = 100
MAX_TRAIL_NAME = 200
# Deliberately plain and ASCII only: internationalised addresses need SMTPUTF8, which not every
# mail server offers.
EMAIL_PATTERN = re.compile(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}")

Limit = Annotated[int, Query(ge=1, le=200)]
Offset = Annotated[int, Query(ge=0)]


# Helpers


def _group_name(value: str | None) -> str:
    name = one_line(value or "")
    if not name:
        raise ApiError(422, "group_name_required")
    if len(name) > MAX_GROUP_NAME:
        raise ApiError(422, "group_name_too_long")
    return name


def _description(value: str | None) -> str | None:
    text = (value or "").replace("\x00", "").strip()
    if len(text) > MAX_DESCRIPTION:
        raise ApiError(422, "description_too_long")
    return text or None


def _nickname(value: str) -> str:
    nickname = one_line(value)
    if not nickname:
        raise ApiError(422, "guest_name_required")
    if len(nickname) > MAX_NICKNAME:
        raise ApiError(422, "guest_name_too_long")
    return nickname


def _normalize_email(value: str) -> str:
    email = value.strip().lower()
    if len(email) > 320 or len(email.split("@")[0]) > 64 or not EMAIL_PATTERN.fullmatch(email):
        raise ApiError(422, "invalid_email")
    return email


def _lock_group(session: Session, group_id: uuid.UUID) -> Group:
    """Serialises changes to a group. Without this, two admins demoting each other at the same
    time could both pass the "at least one admin stays" check. Call it before checking
    permissions, so they are checked against the state after the lock is granted."""
    group = session.scalar(
        select(Group)
        .where(Group.id == group_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if group is None:
        raise ApiError(404, "not_found")
    return group


def _group_out(group: Group, role: GroupRole | None, member_count: int | None) -> GroupOut:
    is_member = role is not None
    return GroupOut(
        id=group.id,
        name=group.name,
        description=group.description if is_member else None,
        visibility=group.visibility,
        is_member=is_member,
        is_admin=role == GroupRole.ADMIN,
        member_count=member_count if is_member else None,
    )


def _describe_group(session: Session, group: Group, user: User) -> GroupOut:
    membership = permissions.get_membership(session, group.id, user)
    member_count = session.scalar(
        select(func.count())
        .select_from(GroupMembership)
        .where(GroupMembership.group_id == group.id)
    )
    return _group_out(group, membership.role if membership else None, member_count)


def _forbid_losing_last_admin(session: Session, membership: GroupMembership) -> None:
    """Callers hold the group's lock."""
    if membership.role != GroupRole.ADMIN:
        return
    admins = session.scalar(
        select(func.count())
        .select_from(GroupMembership)
        .where(
            GroupMembership.group_id == membership.group_id,
            GroupMembership.role == GroupRole.ADMIN,
        )
    )
    if (admins or 0) <= 1:
        raise ApiError(409, "last_admin")


def _app_link(path: str) -> str:
    return f"{get_settings().app_url.rstrip('/')}{path}"


# Invitation links. Declared before /{group_id}, whose paths they could otherwise be taken for.


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _is_expired(invitation: GroupInvitation) -> bool:
    return invitation.expires_at <= datetime.now(UTC)


def _invitation_by_token(session: Session, token: str) -> GroupInvitation:
    invitation = session.scalar(
        select(GroupInvitation).where(GroupInvitation.token_hash == _hash_token(token))
    )
    if invitation is None:
        raise ApiError(404, "invitation_not_found")
    return invitation


def _require_usable(invitation: GroupInvitation) -> None:
    if invitation.status == InvitationStatus.REVOKED:
        raise ApiError(410, "invitation_revoked")
    if invitation.status != InvitationStatus.PENDING:
        raise ApiError(409, "invitation_already_used")
    if _is_expired(invitation):
        raise ApiError(410, "invitation_expired")


def _email_matches(invitation: GroupInvitation, verified_email: str | None) -> bool:
    return verified_email is not None and verified_email.strip().lower() == invitation.email.lower()


@router.get("/invitations/{token}", response_model=InvitationView)
def view_invitation(token: str, verified_email: VerifiedEmail, session: DbSession) -> object:
    invitation = _invitation_by_token(session, token)
    _require_usable(invitation)
    if not _email_matches(invitation, verified_email):
        return InvitationView(
            email_matches=False,
            group_id=None,
            group_name=None,
            inviter_name=None,
            expires_at=invitation.expires_at,
        )
    group = session.get_one(Group, invitation.group_id)
    inviter = session.get(User, invitation.invited_by) if invitation.invited_by else None
    return InvitationView(
        email_matches=True,
        group_id=group.id,
        group_name=group.name,
        inviter_name=inviter.display_name if inviter else None,
        expires_at=invitation.expires_at,
    )


def _claim_invitation(
    session: Session, token: str, verified_email: str | None
) -> tuple[GroupInvitation, Group]:
    invitation = _invitation_by_token(session, token)
    # With the group locked, two clicks on the link cannot both see a pending invitation.
    group = _lock_group(session, invitation.group_id)
    session.refresh(invitation)
    _require_usable(invitation)
    if not _email_matches(invitation, verified_email):
        raise ApiError(403, "invitation_email_mismatch")
    return invitation, group


@router.post("/invitations/{token}/accept", response_model=GroupOut)
def accept_invitation(
    token: str, user: CurrentUser, verified_email: VerifiedEmail, session: DbSession
) -> object:
    invitation, group = _claim_invitation(session, token, verified_email)
    if permissions.get_membership(session, group.id, user) is None:
        session.add(GroupMembership(group_id=group.id, user_id=user.id, role=GroupRole.MEMBER))
    invitation.status = InvitationStatus.ACCEPTED
    # A request they made earlier is settled now too.
    session.execute(
        update(JoinRequest)
        .where(
            JoinRequest.group_id == group.id,
            JoinRequest.user_id == user.id,
            JoinRequest.status == JoinRequestStatus.PENDING,
        )
        .values(status=JoinRequestStatus.APPROVED)
    )
    session.commit()
    return _describe_group(session, group, user)


@router.post("/invitations/{token}/decline", status_code=204)
def decline_invitation(token: str, verified_email: VerifiedEmail, session: DbSession) -> None:
    invitation, _ = _claim_invitation(session, token, verified_email)
    invitation.status = InvitationStatus.DECLINED
    session.commit()


# Groups


@router.get("", response_model=Page[GroupOut])
def list_groups(
    user: CurrentUser,
    session: DbSession,
    scope: Literal["mine", "public"] = "mine",
    q: str = "",
    limit: Limit = 50,
    offset: Offset = 0,
) -> object:
    my_role = (
        select(GroupMembership.role)
        .where(GroupMembership.group_id == Group.id, GroupMembership.user_id == user.id)
        .scalar_subquery()
    )
    member_count = (
        select(func.count())
        .select_from(GroupMembership)
        .where(GroupMembership.group_id == Group.id)
        .scalar_subquery()
    )
    conditions: list[ColumnElement[bool]] = [
        my_role.is_not(None) if scope == "mine" else Group.visibility == GroupVisibility.PUBLIC
    ]
    # Only the name: searching the description would reveal it to non-members.
    search = q.replace("\x00", "").strip()
    if search:
        escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append(Group.name.ilike(f"%{escaped}%", escape="\\"))

    total = session.scalar(select(func.count()).select_from(Group).where(*conditions)) or 0
    rows = session.execute(
        select(Group, my_role, member_count)
        .where(*conditions)
        .order_by(func.lower(Group.name), Group.id)
        .limit(limit)
        .offset(offset)
    ).all()
    items = [_group_out(group, role, count) for group, role, count in rows]
    return Page(items=items, total=total, limit=limit, offset=offset)


@router.post("", response_model=GroupOut, status_code=201)
def create_group(body: GroupCreate, user: CurrentUser, session: DbSession) -> object:
    group = Group(
        name=_group_name(body.name),
        description=_description(body.description),
        visibility=body.visibility,
        created_by=user.id,
    )
    session.add(group)
    session.flush()
    session.add(GroupMembership(group_id=group.id, user_id=user.id, role=GroupRole.ADMIN))
    session.commit()
    return _describe_group(session, group, user)


@router.get("/{group_id}", response_model=GroupOut)
def read_group(group_id: uuid.UUID, user: CurrentUser, session: DbSession) -> object:
    group = permissions.get_visible_group(session, group_id, user)
    return _describe_group(session, group, user)


@router.patch("/{group_id}", response_model=GroupOut)
def update_group(
    group_id: uuid.UUID, body: GroupUpdate, user: CurrentUser, session: DbSession
) -> object:
    group = _lock_group(session, group_id)
    permissions.require_admin(session, group_id, user)
    changes = body.model_dump(exclude_unset=True)
    if "visibility" in changes and changes["visibility"] is None:
        raise ApiError(422, "visibility_required")
    name = _group_name(changes["name"]) if "name" in changes else group.name
    description = (
        _description(changes["description"]) if "description" in changes else group.description
    )

    group.name = name
    group.description = description
    if "visibility" in changes:
        group.visibility = changes["visibility"]
    if group.visibility == GroupVisibility.PRIVATE:
        # Their authors can no longer see this group, so they could not follow them up.
        session.execute(
            update(JoinRequest)
            .where(
                JoinRequest.group_id == group_id,
                JoinRequest.status == JoinRequestStatus.PENDING,
            )
            .values(status=JoinRequestStatus.REJECTED)
        )
    session.commit()
    return _describe_group(session, group, user)


def _free_trail_name(
    session: Session, trail: Trail, group_name: str, scope: ColumnElement[bool]
) -> str:
    """The trail's name or, if `scope` already has it, the name with the group's name added."""

    def taken(name: str) -> bool:
        return bool(
            session.scalar(
                select(exists().where(scope, func.lower(Trail.name) == func.lower(name)))
            )
        )

    if not taken(trail.name):
        return trail.name
    number = 1
    while True:
        suffix = f" ({group_name})" if number == 1 else f" ({group_name} {number})"
        candidate = trail.name[: MAX_TRAIL_NAME - len(suffix)].rstrip() + suffix
        if not taken(candidate):
            return candidate
        number += 1


def _release_shared_trails(session: Session, group: Group) -> None:
    """Trails belong to their creators: private to them from now on. A trail without an owner
    (deleted account) cannot be private to anyone, and others may rely on it, so it is public."""
    trails = session.scalars(
        select(Trail).where(Trail.group_id == group.id).order_by(Trail.created_at, Trail.id)
    ).all()
    for trail in trails:
        scope: ColumnElement[bool]
        if trail.owner_user_id:
            visibility = TrailVisibility.PRIVATE
            scope = (Trail.visibility == TrailVisibility.PRIVATE) & (
                Trail.owner_user_id == trail.owner_user_id
            )
        else:
            visibility = TrailVisibility.PUBLIC
            scope = Trail.visibility == TrailVisibility.PUBLIC
        trail.name = _free_trail_name(session, trail, group.name, scope)
        trail.visibility = visibility
        trail.group_id = None
        # One by one: the next trail's name check must see this one.
        session.flush()


def remove_group(session: Session, group: Group) -> None:
    """Deletes a group by the documented rules, without committing. The caller holds its lock."""
    # Guests' attendance goes with the group's guests, so hikes without a user among their
    # attendees would be left with nobody. The others stay, with group_id set NULL by the FK.
    has_user_attendee = exists().where(
        HikeAttendee.hike_id == Hike.id, HikeAttendee.user_id.is_not(None)
    )
    _release_shared_trails(session, group)
    session.execute(
        delete(Hike)
        .where(Hike.group_id == group.id, ~has_user_attendee)
        .execution_options(synchronize_session=False)
    )
    session.delete(group)


@router.delete("/{group_id}", status_code=204)
def delete_group(group_id: uuid.UUID, user: CurrentUser, session: DbSession) -> None:
    group = _lock_group(session, group_id)
    permissions.require_admin(session, group_id, user)
    try:
        remove_group(session, group)
        session.commit()
    except IntegrityError as exc:
        # A concurrent request took a trail name or shared a trail with this group. Nothing
        # has changed, so it can be tried again.
        session.rollback()
        raise ApiError(409, "group_changed") from exc


# Members


@router.get("/{group_id}/members", response_model=MemberList)
def list_members(group_id: uuid.UUID, user: CurrentUser, session: DbSession) -> object:
    permissions.require_member(session, group_id, user)
    rows = session.execute(
        select(GroupMembership.user_id, User.display_name, GroupMembership.role)
        .join(User, User.id == GroupMembership.user_id)
        .where(GroupMembership.group_id == group_id)
        .order_by(func.lower(User.display_name), User.id)
    ).all()
    return MemberList(
        items=[
            MemberOut(user_id=user_id, display_name=display_name, role=role)
            for user_id, display_name, role in rows
        ]
    )


def _member_or_404(session: Session, group_id: uuid.UUID, user_id: uuid.UUID) -> GroupMembership:
    membership = session.get(GroupMembership, (group_id, user_id))
    if membership is None:
        raise ApiError(404, "not_found")
    return membership


@router.patch("/{group_id}/members/{user_id}", response_model=MemberOut)
def update_member(
    group_id: uuid.UUID,
    user_id: uuid.UUID,
    body: MemberUpdate,
    user: CurrentUser,
    session: DbSession,
) -> object:
    _lock_group(session, group_id)
    permissions.require_admin(session, group_id, user)
    membership = _member_or_404(session, group_id, user_id)
    if body.role != GroupRole.ADMIN:
        _forbid_losing_last_admin(session, membership)
    membership.role = body.role
    session.commit()
    return MemberOut(
        user_id=user_id,
        display_name=session.get_one(User, user_id).display_name,
        role=membership.role,
    )


@router.delete("/{group_id}/members/{user_id}", status_code=204)
def remove_member(
    group_id: uuid.UUID, user_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> None:
    _lock_group(session, group_id)
    permissions.require_admin(session, group_id, user)
    membership = _member_or_404(session, group_id, user_id)
    _forbid_losing_last_admin(session, membership)
    session.delete(membership)
    session.commit()


@router.post("/{group_id}/leave", status_code=204)
def leave_group(group_id: uuid.UUID, user: CurrentUser, session: DbSession) -> None:
    _lock_group(session, group_id)
    membership = permissions.require_member(session, group_id, user)
    _forbid_losing_last_admin(session, membership)
    session.delete(membership)
    session.commit()


# Guests


def _forbid_taken_nickname(
    session: Session, group_id: uuid.UUID, nickname: str, ignore: uuid.UUID | None = None
) -> None:
    """Compared here rather than in SQL: the unique constraint is case-sensitive, and this also
    treats Š and š alike whatever the database's locale. Callers hold the group's lock."""
    guests = session.scalars(select(GroupGuest).where(GroupGuest.group_id == group_id))
    if any(g.nickname.casefold() == nickname.casefold() and g.id != ignore for g in guests):
        raise ApiError(409, "guest_name_taken")


def _guest_or_404(session: Session, group_id: uuid.UUID, guest_id: uuid.UUID) -> GroupGuest:
    guest = session.get(GroupGuest, guest_id)
    if guest is None or guest.group_id != group_id:
        raise ApiError(404, "not_found")
    return guest


@router.get("/{group_id}/guests", response_model=GuestList)
def list_guests(group_id: uuid.UUID, user: CurrentUser, session: DbSession) -> object:
    permissions.require_member(session, group_id, user)
    guests = session.scalars(
        select(GroupGuest)
        .where(GroupGuest.group_id == group_id)
        .order_by(func.lower(GroupGuest.nickname), GroupGuest.id)
    ).all()
    return GuestList(items=[GuestOut.model_validate(guest) for guest in guests])


@router.post("/{group_id}/guests", response_model=GuestOut, status_code=201)
def add_guest(
    group_id: uuid.UUID, body: GuestWrite, user: CurrentUser, session: DbSession
) -> object:
    _lock_group(session, group_id)
    permissions.require_member(session, group_id, user)
    nickname = _nickname(body.nickname)
    _forbid_taken_nickname(session, group_id, nickname)
    guest = GroupGuest(group_id=group_id, nickname=nickname, created_by=user.id)
    session.add(guest)
    session.commit()
    return guest


@router.patch("/{group_id}/guests/{guest_id}", response_model=GuestOut)
def rename_guest(
    group_id: uuid.UUID,
    guest_id: uuid.UUID,
    body: GuestWrite,
    user: CurrentUser,
    session: DbSession,
) -> object:
    _lock_group(session, group_id)
    permissions.require_admin(session, group_id, user)
    guest = _guest_or_404(session, group_id, guest_id)
    nickname = _nickname(body.nickname)
    _forbid_taken_nickname(session, group_id, nickname, ignore=guest.id)
    guest.nickname = nickname
    session.commit()
    return guest


@router.delete("/{group_id}/guests/{guest_id}", status_code=204)
def remove_guest(
    group_id: uuid.UUID, guest_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> None:
    permissions.require_admin(session, group_id, user)
    guest = _guest_or_404(session, group_id, guest_id)
    # Their attendance goes with them. A hike they alone attended would be left with nobody,
    # still counting in the group's totals, so it goes too.
    attended_by_guest = exists().where(
        HikeAttendee.hike_id == Hike.id, HikeAttendee.guest_id == guest.id
    )
    attended_by_others = exists().where(
        HikeAttendee.hike_id == Hike.id,
        or_(HikeAttendee.guest_id.is_(None), HikeAttendee.guest_id != guest.id),
    )
    session.execute(
        delete(Hike)
        .where(Hike.group_id == group_id, attended_by_guest, ~attended_by_others)
        .execution_options(synchronize_session=False)
    )
    session.delete(guest)
    session.commit()


# Invitations (admins)


def _invitation_out(invitation: GroupInvitation) -> InvitationOut:
    return InvitationOut(
        id=invitation.id,
        email=invitation.email,
        status=invitation.status,
        expires_at=invitation.expires_at,
        expired=_is_expired(invitation),
        created_at=invitation.created_at,
    )


def _recipient_locale(session: Session, email: str) -> str | None:
    """The language of the account with this address, if any. It only picks the language of
    the e-mail: the API's response must not depend on whether the address has an account."""
    return session.scalar(
        select(User.locale)
        .where(func.lower(User.email) == email, User.locale.is_not(None))
        .order_by(User.created_at, User.id)
        .limit(1)
    )


def _undo_invitation(
    session: Session,
    invitation_id: uuid.UUID,
    token_hash: str,
    previous: dict[str, object] | None,
) -> None:
    # Matching on the new hash: an invitation revoked in the meantime must stay so.
    still_ours = (GroupInvitation.id == invitation_id) & (GroupInvitation.token_hash == token_hash)
    try:
        if previous is None:
            session.execute(delete(GroupInvitation).where(still_ours))
        else:
            session.execute(update(GroupInvitation).where(still_ours).values(**previous))
        session.commit()
    except SQLAlchemyError:
        # It then shows as pending, and the admin can resend or revoke it.
        session.rollback()
        logger.exception("Could not undo an invitation whose e-mail was not sent")


def _issue_invitation(
    session: Session,
    sender: EmailSender,
    group: Group,
    inviter: User,
    email: str,
    existing: GroupInvitation | None,
) -> InvitationOut:
    """Gives out a new token and e-mails it, after the commit. If sending fails, the admin gets
    503 and things are as before: a new invitation is gone, so it can simply be retried, and a
    re-issued one still has its previous link, which the recipient may already have."""
    enforce(INVITATION_EMAILS, inviter.id)
    token = secrets.token_urlsafe(32)
    token_hash = _hash_token(token)
    previous: dict[str, object] | None = None
    if existing:
        previous = {
            "token_hash": existing.token_hash,
            "expires_at": existing.expires_at,
            "invited_by": existing.invited_by,
        }

    invitation = existing or GroupInvitation(
        group_id=group.id, email=email, status=InvitationStatus.PENDING
    )
    invitation.token_hash = token_hash
    invitation.expires_at = datetime.now(UTC) + timedelta(days=INVITATION_VALID_DAYS)
    invitation.invited_by = inviter.id
    session.add(invitation)
    try:
        session.flush()
    except IntegrityError as exc:
        # Another admin invited the same address just now.
        session.rollback()
        raise ApiError(409, "invitation_pending") from exc
    session.refresh(invitation)

    # Everything that needs the database comes first: no connection is held during SMTP.
    invitation_id = invitation.id
    result = _invitation_out(invitation)
    message = invitation_email(
        to=email,
        group=group.name,
        inviter=inviter.display_name,
        link=_app_link(f"/invitations/{token}"),
        valid_days=INVITATION_VALID_DAYS,
        locale=pick_locale(_recipient_locale(session, email), inviter.locale),
    )
    session.commit()

    try:
        sender.send(message)
    except EmailError as exc:
        logger.warning("Could not send an invitation e-mail: %s", exc)
        _undo_invitation(session, invitation_id, token_hash, previous)
        raise ApiError(503, "email_failed") from exc
    return result


@router.get("/{group_id}/invitations", response_model=Page[InvitationOut])
def list_invitations(
    group_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    limit: Limit = 50,
    offset: Offset = 0,
) -> object:
    """Pending invitations, including expired ones, which admins can resend or revoke."""
    permissions.require_admin(session, group_id, user)
    conditions = (
        GroupInvitation.group_id == group_id,
        GroupInvitation.status == InvitationStatus.PENDING,
    )
    total = session.scalar(select(func.count()).select_from(GroupInvitation).where(*conditions))
    invitations = session.scalars(
        select(GroupInvitation)
        .where(*conditions)
        .order_by(GroupInvitation.created_at, GroupInvitation.id)
        .limit(limit)
        .offset(offset)
    ).all()
    return Page(
        items=[_invitation_out(invitation) for invitation in invitations],
        total=total or 0,
        limit=limit,
        offset=offset,
    )


@router.post("/{group_id}/invitations", response_model=InvitationOut, status_code=201)
def create_invitation(
    group_id: uuid.UUID,
    body: InvitationCreate,
    user: CurrentUser,
    session: DbSession,
    sender: Mailer,
) -> object:
    permissions.require_admin(session, group_id, user)
    group = session.get_one(Group, group_id)
    email = _normalize_email(body.email)

    is_member = session.scalar(
        select(
            exists().where(
                GroupMembership.group_id == group_id,
                GroupMembership.user_id == User.id,
                func.lower(User.email) == email,
            )
        )
    )
    if is_member:
        raise ApiError(409, "already_member")

    existing = session.scalar(
        select(GroupInvitation).where(
            GroupInvitation.group_id == group_id,
            GroupInvitation.status == InvitationStatus.PENDING,
            func.lower(GroupInvitation.email) == email,
        )
    )
    # While the link still works, sending another one takes the explicit "resend".
    if existing and not _is_expired(existing):
        raise ApiError(409, "invitation_pending")
    return _issue_invitation(session, sender, group, user, email, existing)


def _invitation_or_404(
    session: Session, group_id: uuid.UUID, invitation_id: uuid.UUID
) -> GroupInvitation:
    invitation = session.get(GroupInvitation, invitation_id)
    if invitation is None or invitation.group_id != group_id:
        raise ApiError(404, "not_found")
    return invitation


@router.post("/{group_id}/invitations/{invitation_id}/resend", response_model=InvitationOut)
def resend_invitation(
    group_id: uuid.UUID,
    invitation_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    sender: Mailer,
) -> object:
    permissions.require_admin(session, group_id, user)
    invitation = _invitation_or_404(session, group_id, invitation_id)
    if invitation.status != InvitationStatus.PENDING:
        raise ApiError(409, "invitation_not_pending")
    group = session.get_one(Group, group_id)
    return _issue_invitation(session, sender, group, user, invitation.email, invitation)


@router.delete("/{group_id}/invitations/{invitation_id}", status_code=204)
def revoke_invitation(
    group_id: uuid.UUID, invitation_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> None:
    _lock_group(session, group_id)
    permissions.require_admin(session, group_id, user)
    invitation = _invitation_or_404(session, group_id, invitation_id)
    if invitation.status != InvitationStatus.PENDING:
        raise ApiError(409, "invitation_not_pending")
    invitation.status = InvitationStatus.REVOKED
    session.commit()


# Join requests


def _join_request_out(request: JoinRequest, display_name: str) -> JoinRequestOut:
    return JoinRequestOut(
        id=request.id,
        user_id=request.user_id,
        display_name=display_name,
        status=request.status,
        created_at=request.created_at,
    )


def _latest_join_request(session: Session, group_id: uuid.UUID, user: User) -> JoinRequest | None:
    return session.scalar(
        select(JoinRequest)
        .where(JoinRequest.group_id == group_id, JoinRequest.user_id == user.id)
        .order_by(JoinRequest.created_at.desc(), JoinRequest.id)
        .limit(1)
    )


def _admin_notifications(session: Session, group: Group, requester: User) -> list[EmailMessage]:
    admins = session.scalars(
        select(User)
        .join(GroupMembership, GroupMembership.user_id == User.id)
        .where(GroupMembership.group_id == group.id, GroupMembership.role == GroupRole.ADMIN)
    ).all()
    messages = []
    for admin in admins:
        try:
            messages.append(
                join_request_email(
                    to=admin.email,
                    group=group.name,
                    requester=requester.display_name,
                    link=_app_link(f"/groups/{group.id}"),
                    locale=pick_locale(admin.locale, requester.locale),
                )
            )
        except ValueError:
            # An address the mail library refuses. Best effort, so the others still get theirs.
            logger.exception("Could not build a join request notification")
    return messages


@router.post("/{group_id}/join-requests", response_model=JoinRequestOut, status_code=201)
def request_to_join(
    group_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    sender: Mailer,
    background: BackgroundTasks,
) -> object:
    # Without being a member, only a public group gets past this.
    group = permissions.get_visible_group(session, group_id, user)
    if permissions.get_membership(session, group_id, user) is not None:
        raise ApiError(409, "already_member")
    enforce(JOIN_REQUESTS, user.id)
    request = JoinRequest(group_id=group_id, user_id=user.id, status=JoinRequestStatus.PENDING)
    session.add(request)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise ApiError(409, "join_request_pending") from exc
    session.refresh(request)
    result = _join_request_out(request, user.display_name)
    messages = _admin_notifications(session, group, user)
    session.commit()
    # After the response: a slow or failing mail server must not affect the request.
    background.add_task(send_best_effort, sender, messages)
    return result


@router.get("/{group_id}/join-requests/mine", response_model=MyJoinRequest)
def read_my_join_request(group_id: uuid.UUID, user: CurrentUser, session: DbSession) -> object:
    permissions.get_visible_group(session, group_id, user)
    request = _latest_join_request(session, group_id, user)
    is_member = permissions.get_membership(session, group_id, user) is not None
    # An approved request says nothing any more once the person has left the group.
    if request is None or (request.status == JoinRequestStatus.APPROVED and not is_member):
        return MyJoinRequest(id=None, status="none", created_at=None)
    return MyJoinRequest(id=request.id, status=request.status.value, created_at=request.created_at)


@router.delete("/{group_id}/join-requests/mine", status_code=204)
def cancel_my_join_request(group_id: uuid.UUID, user: CurrentUser, session: DbSession) -> None:
    permissions.get_visible_group(session, group_id, user)
    request = _latest_join_request(session, group_id, user)
    if request is None or request.status != JoinRequestStatus.PENDING:
        raise ApiError(404, "not_found")
    session.delete(request)
    session.commit()


@router.get("/{group_id}/join-requests", response_model=Page[JoinRequestOut])
def list_join_requests(
    group_id: uuid.UUID,
    user: CurrentUser,
    session: DbSession,
    limit: Limit = 50,
    offset: Offset = 0,
) -> object:
    """Pending requests."""
    permissions.require_admin(session, group_id, user)
    conditions = (
        JoinRequest.group_id == group_id,
        JoinRequest.status == JoinRequestStatus.PENDING,
    )
    total = session.scalar(select(func.count()).select_from(JoinRequest).where(*conditions))
    rows = session.execute(
        select(JoinRequest, User.display_name)
        .join(User, User.id == JoinRequest.user_id)
        .where(*conditions)
        .order_by(JoinRequest.created_at, JoinRequest.id)
        .limit(limit)
        .offset(offset)
    ).all()
    return Page(
        items=[_join_request_out(request, name) for request, name in rows],
        total=total or 0,
        limit=limit,
        offset=offset,
    )


def _pending_join_request(
    session: Session, group_id: uuid.UUID, request_id: uuid.UUID
) -> JoinRequest:
    request = session.get(JoinRequest, request_id)
    if request is None or request.group_id != group_id:
        raise ApiError(404, "not_found")
    if request.status != JoinRequestStatus.PENDING:
        raise ApiError(409, "join_request_not_pending")
    return request


@router.post("/{group_id}/join-requests/{request_id}/approve", response_model=JoinRequestOut)
def approve_join_request(
    group_id: uuid.UUID, request_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> object:
    _lock_group(session, group_id)
    permissions.require_admin(session, group_id, user)
    request = _pending_join_request(session, group_id, request_id)
    requester = session.get_one(User, request.user_id)
    if permissions.get_membership(session, group_id, requester) is None:
        session.add(GroupMembership(group_id=group_id, user_id=requester.id, role=GroupRole.MEMBER))
    request.status = JoinRequestStatus.APPROVED
    result = _join_request_out(request, requester.display_name)
    session.commit()
    return result


@router.post("/{group_id}/join-requests/{request_id}/reject", response_model=JoinRequestOut)
def reject_join_request(
    group_id: uuid.UUID, request_id: uuid.UUID, user: CurrentUser, session: DbSession
) -> object:
    _lock_group(session, group_id)
    permissions.require_admin(session, group_id, user)
    request = _pending_join_request(session, group_id, request_id)
    request.status = JoinRequestStatus.REJECTED
    result = _join_request_out(request, session.get_one(User, request.user_id).display_name)
    session.commit()
    return result
