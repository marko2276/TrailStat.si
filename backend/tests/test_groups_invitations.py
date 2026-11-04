"""Invitations by e-mail: who can invite, the states of a link, and failures while sending."""

import hashlib
import time
import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import (
    Group,
    GroupInvitation,
    GroupMembership,
    GroupRole,
    GroupVisibility,
    InvitationStatus,
    JoinRequest,
    JoinRequestStatus,
    User,
)
from tests.conftest import KEY_ID, AuthHeaders, CreateUser, FakeSender
from tests.groups_helpers import body_of, make_group, token_in


def invite(
    client: TestClient, group: Group, admin: User, auth_headers: AuthHeaders, email: str
) -> str:
    response = client.post(
        f"/api/groups/{group.id}/invitations", json={"email": email}, headers=auth_headers(admin)
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def invitation_row(session: Session, invitation_id: str) -> GroupInvitation | None:
    session.expire_all()
    return session.get(GroupInvitation, uuid.UUID(invitation_id))


# Creating


def test_admin_invites_and_the_link_is_emailed(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user("Ana")
    group = make_group(session, admins=[admin])

    response = client.post(
        f"/api/groups/{group.id}/invitations",
        json={"email": "  New.Person@Example.COM "},
        headers=auth_headers(admin),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "new.person@example.com"
    assert body["status"] == "pending"
    assert body["expired"] is False
    expires_at = datetime.fromisoformat(body["expires_at"])
    assert timedelta(days=6, hours=23) < expires_at - datetime.now(UTC) <= timedelta(days=7)

    assert len(outbox.messages) == 1
    message = outbox.messages[0]
    assert message["To"] == "new.person@example.com"
    token = token_in(message)
    assert f"{get_settings().app_url}/invitations/{token}" in body_of(message)
    assert "Hikers" in body_of(message)
    assert "Ana" in body_of(message)


def test_only_a_hash_of_the_token_is_stored_and_it_is_not_returned(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])

    response = client.post(
        f"/api/groups/{group.id}/invitations", json={"email": "a@b.si"}, headers=auth_headers(admin)
    )

    token = token_in(outbox.messages[0])
    assert len(token) >= 40
    row = invitation_row(session, response.json()["id"])
    assert row is not None
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert token not in response.text
    assert row.token_hash not in response.text
    listed = client.get(f"/api/groups/{group.id}/invitations", headers=auth_headers(admin))
    assert token not in listed.text
    assert row.token_hash not in listed.text


@pytest.mark.parametrize(
    "email",
    [
        "",
        "plain",
        "@b.si",
        "a@",
        "a@b",
        "a b@c.si",
        "a@b.si\nBcc: evil@x.si",
        "a@b.si,evil@x.si",
        "Name <a@b.si>",
        "x" * 65 + "@b.si",
    ],
)
def test_bad_addresses_are_rejected(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
    email: str,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])

    response = client.post(
        f"/api/groups/{group.id}/invitations", json={"email": email}, headers=auth_headers(admin)
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "invalid_email"
    assert outbox.messages == []


def test_plain_member_and_outsider_cannot_invite_or_see_invitations(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, member = create_user(), create_user()
    group = make_group(session, visibility=GroupVisibility.PUBLIC, admins=[admin], members=[member])
    invitation_id = invite(client, group, admin, auth_headers, "a@b.si")
    outbox.messages.clear()
    base = f"/api/groups/{group.id}/invitations"

    for user in (member, create_user()):
        headers = auth_headers(user)
        assert client.post(base, json={"email": "c@d.si"}, headers=headers).status_code == 403
        assert client.get(base, headers=headers).status_code == 403
        assert client.delete(f"{base}/{invitation_id}", headers=headers).status_code == 403
        assert client.post(f"{base}/{invitation_id}/resend", headers=headers).status_code == 403
    assert outbox.messages == []
    row = invitation_row(session, invitation_id)
    assert row is not None
    assert row.status == InvitationStatus.PENDING


def test_inviting_an_existing_member_is_a_conflict(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    member = create_user(email="Member@Example.com")
    group = make_group(session, admins=[admin], members=[member])

    response = client.post(
        f"/api/groups/{group.id}/invitations",
        json={"email": "member@example.com"},
        headers=auth_headers(admin),
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "already_member"
    assert outbox.messages == []


def test_response_does_not_reveal_whether_the_address_has_an_account(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    create_user(email="exists@example.com", locale="sl")
    group = make_group(session, admins=[admin])
    url = f"/api/groups/{group.id}/invitations"

    with_account = client.post(
        url, json={"email": "exists@example.com"}, headers=auth_headers(admin)
    )
    without = client.post(url, json={"email": "nobody@example.com"}, headers=auth_headers(admin))

    assert with_account.status_code == without.status_code == 201
    assert set(with_account.json()) == set(without.json())
    for field in ("status", "expired"):
        assert with_account.json()[field] == without.json()[field]


def test_inviting_again_while_pending_is_a_conflict(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    invite(client, group, admin, auth_headers, "a@b.si")
    first_token = token_in(outbox.messages[0])

    response = client.post(
        f"/api/groups/{group.id}/invitations", json={"email": "A@B.si"}, headers=auth_headers(admin)
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "invitation_pending"
    assert len(outbox.messages) == 1
    # The link already sent keeps working.
    view = client.get(
        f"/api/groups/invitations/{first_token}",
        headers=auth_headers(create_user(email="a@b.si")),
    )
    assert view.status_code == 200


def test_inviting_again_after_expiry_issues_a_new_link(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    invitation_id = invite(client, group, admin, auth_headers, "a@b.si")
    row = invitation_row(session, invitation_id)
    assert row is not None
    row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    session.commit()

    second_id = invite(client, group, admin, auth_headers, "a@b.si")

    assert second_id == invitation_id
    assert len(outbox.messages) == 2
    response = client.get(
        f"/api/groups/invitations/{token_in(outbox.messages[1])}",
        headers=auth_headers(create_user(email="a@b.si")),
    )
    assert response.status_code == 200


def test_inviting_again_after_a_decline_or_revocation_works(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    first = invite(client, group, admin, auth_headers, "a@b.si")
    client.delete(f"/api/groups/{group.id}/invitations/{first}", headers=auth_headers(admin))

    second = invite(client, group, admin, auth_headers, "a@b.si")

    assert second != first


# E-mail failures


def test_failed_send_reports_503_and_leaves_no_invitation(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    outbox.fail = True

    response = client.post(
        f"/api/groups/{group.id}/invitations", json={"email": "a@b.si"}, headers=auth_headers(admin)
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "email_failed"
    session.expire_all()
    rows = session.scalars(select(GroupInvitation).where(GroupInvitation.group_id == group.id))
    assert rows.all() == []
    # So trying again is not blocked.
    outbox.fail = False
    invite(client, group, admin, auth_headers, "a@b.si")
    assert len(outbox.messages) == 1


def test_failed_resend_keeps_the_previous_link_working(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    invitation_id = invite(client, group, admin, auth_headers, "a@b.si")
    token = token_in(outbox.messages[0])
    row = invitation_row(session, invitation_id)
    assert row is not None
    previous_expiry = row.expires_at
    outbox.fail = True

    response = client.post(
        f"/api/groups/{group.id}/invitations/{invitation_id}/resend", headers=auth_headers(admin)
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "email_failed"
    row = invitation_row(session, invitation_id)
    assert row is not None
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    assert row.expires_at == previous_expiry
    view = client.get(
        f"/api/groups/invitations/{token}", headers=auth_headers(create_user(email="a@b.si"))
    )
    assert view.status_code == 200


# Listing, revoking and resending


def test_admin_lists_pending_invitations_including_expired_ones(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    expired = invite(client, group, admin, auth_headers, "expired@b.si")
    invite(client, group, admin, auth_headers, "pending@b.si")
    revoked = invite(client, group, admin, auth_headers, "revoked@b.si")
    client.delete(f"/api/groups/{group.id}/invitations/{revoked}", headers=auth_headers(admin))
    row = invitation_row(session, expired)
    assert row is not None
    row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    session.commit()

    body = client.get(f"/api/groups/{group.id}/invitations", headers=auth_headers(admin)).json()

    assert body["total"] == 2
    assert {item["email"]: item["expired"] for item in body["items"]} == {
        "expired@b.si": True,
        "pending@b.si": False,
    }


def test_resend_issues_a_new_token_and_invalidates_the_old_one(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    invitation_id = invite(client, group, admin, auth_headers, "a@b.si")
    old_token = token_in(outbox.messages[0])
    invitee = auth_headers(create_user(email="a@b.si"))

    response = client.post(
        f"/api/groups/{group.id}/invitations/{invitation_id}/resend", headers=auth_headers(admin)
    )

    assert response.status_code == 200
    new_token = token_in(outbox.messages[1])
    assert new_token != old_token
    assert client.get(f"/api/groups/invitations/{old_token}", headers=invitee).status_code == 404
    assert client.get(f"/api/groups/invitations/{new_token}", headers=invitee).status_code == 200


def test_resend_renews_an_expired_invitation(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    invitation_id = invite(client, group, admin, auth_headers, "a@b.si")
    row = invitation_row(session, invitation_id)
    assert row is not None
    row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    session.commit()

    response = client.post(
        f"/api/groups/{group.id}/invitations/{invitation_id}/resend", headers=auth_headers(admin)
    )

    assert response.json()["expired"] is False


def test_revoked_invitation_cannot_be_revoked_or_resent_again(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    invitation_id = invite(client, group, admin, auth_headers, "a@b.si")
    url = f"/api/groups/{group.id}/invitations/{invitation_id}"
    headers = auth_headers(admin)

    assert client.delete(url, headers=headers).status_code == 204
    assert client.delete(url, headers=headers).status_code == 409
    response = client.post(f"{url}/resend", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "invitation_not_pending"


def test_invitation_of_another_group_is_404(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    other = make_group(session, name="Other", admins=[admin])
    invitation_id = invite(client, other, admin, auth_headers, "a@b.si")
    url = f"/api/groups/{group.id}/invitations/{invitation_id}"

    assert client.delete(url, headers=auth_headers(admin)).status_code == 404
    assert client.post(f"{url}/resend", headers=auth_headers(admin)).status_code == 404


# Using the link


@pytest.fixture
def invitation(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> tuple[Group, str, str, User]:
    """A private group with an invitation for invitee@example.com: (group, id, token, admin)."""
    admin = create_user("Ana")
    group = make_group(session, name="Secret club", admins=[admin])
    invitation_id = invite(client, group, admin, auth_headers, "invitee@example.com")
    return group, invitation_id, token_in(outbox.messages[-1]), admin


def test_invitee_sees_the_invitation(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
) -> None:
    group, _, token, _ = invitation
    invitee = create_user(email="Invitee@Example.com")

    body = client.get(f"/api/groups/invitations/{token}", headers=auth_headers(invitee)).json()

    assert body["email_matches"] is True
    assert body["group_id"] == str(group.id)
    assert body["group_name"] == "Secret club"
    assert body["inviter_name"] == "Ana"


def test_viewing_needs_sign_in(
    client: TestClient, invitation: tuple[Group, str, str, User]
) -> None:
    _, _, token, _ = invitation
    assert client.get(f"/api/groups/invitations/{token}").status_code == 401
    assert client.post(f"/api/groups/invitations/{token}/accept").status_code == 401
    assert client.post(f"/api/groups/invitations/{token}/decline").status_code == 401


def test_someone_else_with_the_link_learns_nothing_about_the_group(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
) -> None:
    _, _, token, _ = invitation

    response = client.get(
        f"/api/groups/invitations/{token}", headers=auth_headers(create_user(email="x@example.com"))
    )

    assert response.status_code == 200
    assert response.json()["email_matches"] is False
    assert response.json()["group_id"] is None
    assert response.json()["group_name"] is None
    assert response.json()["inviter_name"] is None
    assert "Secret club" not in response.text
    assert "invitee@example.com" not in response.text


def test_accepting_makes_the_invitee_a_plain_member(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
) -> None:
    group, invitation_id, token, _ = invitation
    invitee = create_user(email="INVITEE@example.com")

    response = client.post(f"/api/groups/invitations/{token}/accept", headers=auth_headers(invitee))

    assert response.status_code == 200
    assert response.json()["is_member"] is True
    assert response.json()["is_admin"] is False
    assert response.json()["member_count"] == 2
    membership = session.get_one(GroupMembership, (group.id, invitee.id))
    assert membership.role == GroupRole.MEMBER
    row = invitation_row(session, invitation_id)
    assert row is not None
    assert row.status == InvitationStatus.ACCEPTED
    # And the private group is now visible to them.
    assert client.get(f"/api/groups/{group.id}", headers=auth_headers(invitee)).status_code == 200


def test_a_new_account_can_accept(
    client: TestClient,
    session: Session,
    make_token: object,
    invitation: tuple[Group, str, str, User],
) -> None:
    """Someone without an account signs up via the link: their first request creates the user."""
    group, _, token, _ = invitation
    jwt_token = make_token(subject="brand-new", email="invitee@example.com")  # type: ignore[operator]

    response = client.post(
        f"/api/groups/invitations/{token}/accept",
        headers={"Authorization": f"Bearer {jwt_token}"},
    )

    assert response.status_code == 200
    user = session.scalars(select(User).where(User.auth_subject == "brand-new")).one()
    assert session.get(GroupMembership, (group.id, user.id)) is not None


@pytest.mark.parametrize("action", ["accept", "decline"])
def test_a_forwarded_link_cannot_be_used_by_someone_else(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
    action: str,
) -> None:
    group, invitation_id, token, _ = invitation
    other = create_user(email="other@example.com")

    response = client.post(f"/api/groups/invitations/{token}/{action}", headers=auth_headers(other))

    assert response.status_code == 403
    assert response.json()["detail"] == "invitation_email_mismatch"
    assert session.get(GroupMembership, (group.id, other.id)) is None
    row = invitation_row(session, invitation_id)
    assert row is not None
    assert row.status == InvitationStatus.PENDING


@pytest.mark.parametrize(
    "email_claim",
    [
        {"address": "invitee@example.com", "is_primary": True, "is_verified": False},
        {"address": "invitee@example.com", "is_primary": True},
        "invitee@example.com",
    ],
    ids=["unverified", "no-flag", "plain-string"],
)
def test_an_address_that_is_not_verified_cannot_accept(
    client: TestClient,
    session: Session,
    rsa_key: rsa.RSAPrivateKey,
    invitation: tuple[Group, str, str, User],
    email_claim: object,
) -> None:
    """Otherwise anyone could sign up with the invitee's address, without proving it's theirs."""
    group, _, token, _ = invitation
    claims = {"sub": "impostor", "exp": int(time.time()) + 3600, "email": email_claim}
    jwt_token = jwt.encode(claims, rsa_key, algorithm="RS256", headers={"kid": KEY_ID})
    headers = {"Authorization": f"Bearer {jwt_token}"}

    view = client.get(f"/api/groups/invitations/{token}", headers=headers)
    response = client.post(f"/api/groups/invitations/{token}/accept", headers=headers)

    assert view.json()["email_matches"] is False
    assert view.json()["group_name"] is None
    assert response.status_code == 403
    assert response.json()["detail"] == "invitation_email_mismatch"
    user = session.scalars(select(User).where(User.auth_subject == "impostor")).one()
    assert session.get(GroupMembership, (group.id, user.id)) is None


def test_declining_keeps_the_invitee_out_and_uses_up_the_link(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
) -> None:
    group, invitation_id, token, _ = invitation
    invitee = create_user(email="invitee@example.com")
    headers = auth_headers(invitee)

    response = client.post(f"/api/groups/invitations/{token}/decline", headers=headers)

    assert response.status_code == 204
    row = invitation_row(session, invitation_id)
    assert row is not None
    assert row.status == InvitationStatus.DECLINED
    assert session.get(GroupMembership, (group.id, invitee.id)) is None
    response = client.post(f"/api/groups/invitations/{token}/accept", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "invitation_already_used"


@pytest.mark.parametrize("path", ["", "/accept", "/decline"])
def test_expired_link_is_gone(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
    path: str,
) -> None:
    group, invitation_id, token, _ = invitation
    invitee = create_user(email="invitee@example.com")
    row = invitation_row(session, invitation_id)
    assert row is not None
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    session.commit()

    url = f"/api/groups/invitations/{token}{path}"
    headers = auth_headers(invitee)
    response = client.get(url, headers=headers) if not path else client.post(url, headers=headers)

    assert response.status_code == 410
    assert response.json()["detail"] == "invitation_expired"
    assert session.get(GroupMembership, (group.id, invitee.id)) is None


@pytest.mark.parametrize("path", ["", "/accept", "/decline"])
def test_revoked_link_is_gone(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
    path: str,
) -> None:
    group, invitation_id, token, admin = invitation
    invitee = create_user(email="invitee@example.com")
    client.delete(
        f"/api/groups/{group.id}/invitations/{invitation_id}", headers=auth_headers(admin)
    )

    url = f"/api/groups/invitations/{token}{path}"
    headers = auth_headers(invitee)
    response = client.get(url, headers=headers) if not path else client.post(url, headers=headers)

    assert response.status_code == 410
    assert response.json()["detail"] == "invitation_revoked"
    assert session.get(GroupMembership, (group.id, invitee.id)) is None


def test_link_works_once(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
) -> None:
    _, _, token, _ = invitation
    headers = auth_headers(create_user(email="invitee@example.com"))

    assert (
        client.post(f"/api/groups/invitations/{token}/accept", headers=headers).status_code == 200
    )
    for response in (
        client.post(f"/api/groups/invitations/{token}/accept", headers=headers),
        client.post(f"/api/groups/invitations/{token}/decline", headers=headers),
        client.get(f"/api/groups/invitations/{token}", headers=headers),
    ):
        assert response.status_code == 409
        assert response.json()["detail"] == "invitation_already_used"


@pytest.mark.parametrize("path", ["", "/accept", "/decline"])
def test_unknown_token_is_404(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, path: str
) -> None:
    url = f"/api/groups/invitations/not-a-real-token{path}"
    headers = auth_headers(create_user())
    response = client.get(url, headers=headers) if not path else client.post(url, headers=headers)

    assert response.status_code == 404
    assert response.json()["detail"] == "invitation_not_found"


def test_the_raw_hash_is_not_a_valid_token(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
) -> None:
    _, invitation_id, _, _ = invitation
    row = invitation_row(session, invitation_id)
    assert row is not None

    response = client.get(
        f"/api/groups/invitations/{row.token_hash}",
        headers=auth_headers(create_user(email="invitee@example.com")),
    )

    assert response.status_code == 404


def test_accepting_when_already_a_member_changes_nothing(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
) -> None:
    group, _, token, admin = invitation
    invitee = create_user(email="invitee@example.com")
    session.add(GroupMembership(group_id=group.id, user_id=invitee.id, role=GroupRole.ADMIN))
    session.commit()

    response = client.post(f"/api/groups/invitations/{token}/accept", headers=auth_headers(invitee))

    assert response.status_code == 200
    assert response.json()["is_admin"] is True


def test_accepting_settles_an_earlier_join_request(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    invitation: tuple[Group, str, str, User],
) -> None:
    group, _, token, _ = invitation
    invitee = create_user(email="invitee@example.com")
    request = JoinRequest(group_id=group.id, user_id=invitee.id, status=JoinRequestStatus.PENDING)
    session.add(request)
    session.commit()

    client.post(f"/api/groups/invitations/{token}/accept", headers=auth_headers(invitee))

    session.expire_all()
    assert request.status == JoinRequestStatus.APPROVED


# The language of the e-mail


@pytest.mark.parametrize(
    ("recipient_locale", "inviter_locale", "expected"),
    [
        ("sl", "en", "Pozdravljeni"),
        ("en", "sl", "Hello"),
        ("sl-SI", None, "Pozdravljeni"),
        (None, "sl", "Pozdravljeni"),
        (None, None, "Hello"),
        ("de", "sl", "Pozdravljeni"),
        ("de", None, "Hello"),
    ],
)
def test_language_follows_the_recipient_then_the_inviter_then_english(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
    recipient_locale: str | None,
    inviter_locale: str | None,
    expected: str,
) -> None:
    admin = create_user(locale=inviter_locale)
    create_user(email="Recipient@Example.com", locale=recipient_locale)
    group = make_group(session, admins=[admin])

    invite(client, group, admin, auth_headers, "recipient@example.com")

    assert expected in body_of(outbox.messages[0])


def test_no_account_uses_the_inviters_language(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user(locale="sl")
    group = make_group(session, admins=[admin])

    invite(client, group, admin, auth_headers, "nobody@example.com")

    assert "Pozdravljeni" in body_of(outbox.messages[0])
    assert "skupino" in outbox.messages[0]["Subject"]
