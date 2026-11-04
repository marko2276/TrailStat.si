"""Asking to join a public group."""

import uuid

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import (
    Group,
    GroupMembership,
    GroupRole,
    GroupVisibility,
    JoinRequest,
    JoinRequestStatus,
    User,
)
from tests.conftest import AuthHeaders, CreateUser, FakeSender
from tests.groups_helpers import body_of, make_group


def public_group(session: Session, admin: User, *admins: User) -> Group:
    return make_group(session, visibility=GroupVisibility.PUBLIC, admins=[admin, *admins])


def make_request(client: TestClient, group: Group, user: User, auth_headers: AuthHeaders) -> str:
    response = client.post(f"/api/groups/{group.id}/join-requests", headers=auth_headers(user))
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def test_any_user_can_ask_and_sees_the_status(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    user = create_user("Bor")
    group = public_group(session, create_user())
    headers = auth_headers(user)
    url = f"/api/groups/{group.id}/join-requests"

    assert client.get(f"{url}/mine", headers=headers).json()["status"] == "none"

    response = client.post(url, headers=headers)

    assert response.status_code == 201
    assert response.json()["status"] == "pending"
    assert response.json()["display_name"] == "Bor"
    mine = client.get(f"{url}/mine", headers=headers).json()
    assert mine["status"] == "pending"
    assert mine["id"] == response.json()["id"]
    assert session.get(GroupMembership, (group.id, user.id)) is None


def test_private_group_cannot_be_requested(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    group = make_group(session, admins=[create_user()])

    response = client.post(
        f"/api/groups/{group.id}/join-requests", headers=auth_headers(create_user())
    )

    assert response.status_code == 404
    assert outbox.messages == []


def test_duplicate_request_is_a_conflict(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    user = create_user()
    group = public_group(session, create_user())
    make_request(client, group, user, auth_headers)

    response = client.post(f"/api/groups/{group.id}/join-requests", headers=auth_headers(user))

    assert response.status_code == 409
    assert response.json()["detail"] == "join_request_pending"
    assert (
        client.get(f"/api/groups/{group.id}/join-requests/mine", headers=auth_headers(user)).json()[
            "status"
        ]
        == "pending"
    )


def test_member_cannot_request(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = public_group(session, admin)

    response = client.post(f"/api/groups/{group.id}/join-requests", headers=auth_headers(admin))

    assert response.status_code == 409
    assert response.json()["detail"] == "already_member"


def test_admins_are_notified_each_in_their_language(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    english = create_user(email="en@example.com", locale="en")
    slovene = create_user(email="sl@example.com", locale="sl")
    plain_member = create_user(email="member@example.com")
    group = public_group(session, english, slovene)
    session.add(GroupMembership(group_id=group.id, user_id=plain_member.id, role=GroupRole.MEMBER))
    session.commit()

    make_request(client, group, create_user("Bor"), auth_headers)

    bodies = {message["To"]: body_of(message) for message in outbox.messages}
    assert set(bodies) == {"en@example.com", "sl@example.com"}
    assert "Hello" in bodies["en@example.com"]
    assert "Pozdravljeni" in bodies["sl@example.com"]
    assert "Bor" in bodies["en@example.com"]
    assert f"/groups/{group.id}" in bodies["en@example.com"]


def test_failed_notification_does_not_fail_the_request(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    user = create_user()
    group = public_group(session, create_user())
    outbox.fail = True

    make_request(client, group, user, auth_headers)

    assert (
        client.get(f"/api/groups/{group.id}/join-requests/mine", headers=auth_headers(user)).json()[
            "status"
        ]
        == "pending"
    )


def test_admin_lists_pending_requests_without_email_addresses(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    requester = create_user("Bor", email="bor@example.com")
    group = public_group(session, admin)
    request_id = make_request(client, group, requester, auth_headers)

    response = client.get(f"/api/groups/{group.id}/join-requests", headers=auth_headers(admin))

    body = response.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == request_id
    assert body["items"][0]["display_name"] == "Bor"
    assert "bor@example.com" not in response.text


def test_plain_member_and_outsider_cannot_handle_requests(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    member = create_user()
    requester = create_user()
    group = public_group(session, create_user())
    session.add(GroupMembership(group_id=group.id, user_id=member.id, role=GroupRole.MEMBER))
    session.commit()
    request_id = make_request(client, group, requester, auth_headers)
    url = f"/api/groups/{group.id}/join-requests"

    for user in (member, create_user(), requester):
        headers = auth_headers(user)
        assert client.get(url, headers=headers).status_code == 403
        assert client.post(f"{url}/{request_id}/approve", headers=headers).status_code == 403
        assert client.post(f"{url}/{request_id}/reject", headers=headers).status_code == 403
    assert session.get(GroupMembership, (group.id, requester.id)) is None


def test_approving_makes_a_plain_member(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, requester = create_user(), create_user()
    group = public_group(session, admin)
    request_id = make_request(client, group, requester, auth_headers)
    url = f"/api/groups/{group.id}/join-requests"

    response = client.post(f"{url}/{request_id}/approve", headers=auth_headers(admin))

    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    assert session.get_one(GroupMembership, (group.id, requester.id)).role == GroupRole.MEMBER
    mine = client.get(f"{url}/mine", headers=auth_headers(requester)).json()
    assert mine["status"] == "approved"
    assert client.get(url, headers=auth_headers(admin)).json()["total"] == 0


def test_rejecting_keeps_them_out_but_they_can_ask_again(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, requester = create_user(), create_user()
    group = public_group(session, admin)
    request_id = make_request(client, group, requester, auth_headers)
    url = f"/api/groups/{group.id}/join-requests"

    response = client.post(f"{url}/{request_id}/reject", headers=auth_headers(admin))

    assert response.status_code == 200
    assert session.get(GroupMembership, (group.id, requester.id)) is None
    assert client.get(f"{url}/mine", headers=auth_headers(requester)).json()["status"] == "rejected"
    make_request(client, group, requester, auth_headers)


def test_handled_request_cannot_be_handled_again(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, requester = create_user(), create_user()
    group = public_group(session, admin)
    request_id = make_request(client, group, requester, auth_headers)
    url = f"/api/groups/{group.id}/join-requests/{request_id}"
    client.post(f"{url}/reject", headers=auth_headers(admin))

    response = client.post(f"{url}/approve", headers=auth_headers(admin))

    assert response.status_code == 409
    assert response.json()["detail"] == "join_request_not_pending"
    assert session.get(GroupMembership, (group.id, requester.id)) is None


def test_request_of_another_group_or_unknown_is_404(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = public_group(session, admin)
    other = make_group(session, name="Other", visibility=GroupVisibility.PUBLIC)
    request_id = make_request(client, other, create_user(), auth_headers)
    headers = auth_headers(admin)
    url = f"/api/groups/{group.id}/join-requests"

    assert client.post(f"{url}/{request_id}/approve", headers=headers).status_code == 404
    assert client.post(f"{url}/{uuid.uuid4()}/reject", headers=headers).status_code == 404


def test_requester_cancels(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, requester = create_user(), create_user()
    group = public_group(session, admin)
    make_request(client, group, requester, auth_headers)
    url = f"/api/groups/{group.id}/join-requests"
    headers = auth_headers(requester)

    assert client.delete(f"{url}/mine", headers=headers).status_code == 204

    assert client.get(f"{url}/mine", headers=headers).json()["status"] == "none"
    assert client.get(url, headers=auth_headers(admin)).json()["total"] == 0
    assert client.delete(f"{url}/mine", headers=headers).status_code == 404
    make_request(client, group, requester, auth_headers)


def test_cancel_only_affects_your_own_request(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, requester = create_user(), create_user()
    group = public_group(session, admin)
    request_id = make_request(client, group, requester, auth_headers)

    response = client.delete(
        f"/api/groups/{group.id}/join-requests/mine", headers=auth_headers(create_user())
    )

    assert response.status_code == 404
    assert session.get(JoinRequest, uuid.UUID(request_id)) is not None


def test_a_handled_request_cannot_be_cancelled(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, requester = create_user(), create_user()
    group = public_group(session, admin)
    request_id = make_request(client, group, requester, auth_headers)
    url = f"/api/groups/{group.id}/join-requests"
    client.post(f"{url}/{request_id}/reject", headers=auth_headers(admin))

    response = client.delete(f"{url}/mine", headers=auth_headers(requester))

    assert response.status_code == 404
    session.expire_all()
    assert session.get_one(JoinRequest, uuid.UUID(request_id)).status == JoinRequestStatus.REJECTED


def test_someone_who_left_can_ask_again_and_is_not_shown_as_approved(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, requester = create_user(), create_user()
    group = public_group(session, admin)
    request_id = make_request(client, group, requester, auth_headers)
    url = f"/api/groups/{group.id}/join-requests"
    client.post(f"{url}/{request_id}/approve", headers=auth_headers(admin))
    client.post(f"/api/groups/{group.id}/leave", headers=auth_headers(requester))

    assert client.get(f"{url}/mine", headers=auth_headers(requester)).json()["status"] == "none"
    make_request(client, group, requester, auth_headers)
