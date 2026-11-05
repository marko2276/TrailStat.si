"""The limiter itself, and the limits on e-mails. The limit on OSM is in test_trails_osm.py."""

import threading
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.errors import ApiError
from app.models import GroupVisibility, User
from app.rate_limit import INVITATION_EMAILS, JOIN_REQUESTS, OSM_REQUESTS, RateLimit, enforce
from tests.conftest import AuthHeaders, CreateUser, FakeSender
from tests.groups_helpers import make_group

LIMIT = RateLimit("test", 2, 60)


def test_the_limits_are_the_documented_ones() -> None:
    assert (INVITATION_EMAILS.max_calls, INVITATION_EMAILS.window_s) == (20, 3600)
    assert (JOIN_REQUESTS.max_calls, JOIN_REQUESTS.window_s) == (10, 3600)
    assert (OSM_REQUESTS.max_calls, OSM_REQUESTS.window_s) == (20, 60)


def test_refuses_above_the_limit() -> None:
    user = uuid.uuid4()
    enforce(LIMIT, user)
    enforce(LIMIT, user)

    with pytest.raises(ApiError) as refused:
        enforce(LIMIT, user)

    assert refused.value.status_code == 429
    assert refused.value.detail == "rate_limited"


def test_the_window_slides(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    monkeypatch.setattr("app.rate_limit.time.monotonic", lambda: now[0])
    user = uuid.uuid4()
    enforce(LIMIT, user)
    now[0] += 40
    enforce(LIMIT, user)
    now[0] += 19
    with pytest.raises(ApiError):
        enforce(LIMIT, user)

    # The first call has left the window, the second hasn't.
    now[0] += 1
    enforce(LIMIT, user)
    with pytest.raises(ApiError):
        enforce(LIMIT, user)


def test_counts_per_user_and_per_action() -> None:
    user = uuid.uuid4()
    enforce(LIMIT, user)
    enforce(LIMIT, user)

    enforce(LIMIT, uuid.uuid4())
    enforce(RateLimit("other", 2, 60), user)


def test_exact_under_concurrency() -> None:
    limit = RateLimit("threads", 50, 60)
    user = uuid.uuid4()
    allowed: list[bool] = []
    start = threading.Barrier(8)

    def call() -> None:
        start.wait()
        for _ in range(25):
            try:
                enforce(limit, user)
                allowed.append(True)
            except ApiError:
                pass

    threads = [threading.Thread(target=call) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(allowed) == 50


def invite(client: TestClient, group_id: uuid.UUID, headers: dict[str, str], email: str) -> int:
    url = f"/api/groups/{group_id}/invitations"
    return int(client.post(url, json={"email": email}, headers=headers).status_code)


def test_invitation_emails_are_limited_per_user_counting_resends(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, other_admin = create_user(), create_user()
    group = make_group(session, admins=[admin, other_admin])
    headers = auth_headers(admin)

    for number in range(10):
        assert invite(client, group.id, headers, f"a{number}@example.com") == 201
    invitation = client.get(f"/api/groups/{group.id}/invitations", headers=headers).json()
    resend = f"/api/groups/{group.id}/invitations/{invitation['items'][0]['id']}/resend"
    for _ in range(10):
        assert client.post(resend, headers=headers).status_code == 200
    assert len(outbox.messages) == 20

    assert invite(client, group.id, headers, "more@example.com") == 429
    refused = client.post(resend, headers=headers)
    assert (refused.status_code, refused.json()["detail"]) == (429, "rate_limited")
    assert len(outbox.messages) == 20
    # Nothing was left behind: the address can be invited later, and shows nowhere.
    listed = client.get(f"/api/groups/{group.id}/invitations", headers=headers).json()
    assert "more@example.com" not in {item["email"] for item in listed["items"]}

    # A different admin has their own count.
    assert invite(client, group.id, auth_headers(other_admin), "more@example.com") == 201


def test_invitations_refused_for_other_reasons_do_not_count(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    headers = auth_headers(admin)
    assert invite(client, group.id, headers, "a@example.com") == 201

    for _ in range(25):
        assert invite(client, group.id, headers, "a@example.com") == 409

    assert invite(client, group.id, headers, "b@example.com") == 201


def test_join_requests_are_limited_per_user(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, user = create_user(), create_user()
    groups = [
        make_group(session, name=f"G{n}", visibility=GroupVisibility.PUBLIC, admins=[admin])
        for n in range(11)
    ]

    def join(who: User, group_id: uuid.UUID) -> int:
        url = f"/api/groups/{group_id}/join-requests"
        return int(client.post(url, headers=auth_headers(who)).status_code)

    for group in groups[:10]:
        assert join(user, group.id) == 201
    sent = len(outbox.messages)

    assert join(user, groups[10].id) == 429
    assert len(outbox.messages) == sent

    assert join(create_user(), groups[10].id) == 201


def test_cancelling_and_asking_again_cannot_get_around_the_limit(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    user = create_user()
    group = make_group(session, visibility=GroupVisibility.PUBLIC, admins=[create_user()])
    url = f"/api/groups/{group.id}/join-requests"
    headers = auth_headers(user)

    for _ in range(10):
        assert client.post(url, headers=headers).status_code == 201
        assert client.delete(f"{url}/mine", headers=headers).status_code == 204

    assert client.post(url, headers=headers).status_code == 429
    assert len(outbox.messages) == 10
