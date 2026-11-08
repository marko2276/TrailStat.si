"""The admin page: open only to ADMIN_USER_IDS, and totals only."""

from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models import (
    GroupInvitation,
    GroupVisibility,
    InvitationStatus,
    TrailVisibility,
    User,
)
from tests.conftest import AuthHeaders, CreateUser
from tests.groups_helpers import make_group, make_guest, make_hike, make_trail


@pytest.fixture
def admin(create_user: CreateUser, monkeypatch: pytest.MonkeyPatch) -> User:
    user = create_user("Admin", locale="sl")
    monkeypatch.setattr(get_settings(), "admin_user_ids", f" other-id , {user.auth_subject} ")
    return user


def test_admin_ids_are_a_comma_separated_list() -> None:
    assert Settings(admin_user_ids=" a, b ,,").admin_subjects == {"a", "b"}
    assert Settings(admin_user_ids="").admin_subjects == frozenset()


def test_others_do_not_see_that_the_page_exists(
    client: TestClient, admin: User, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    hiker = create_user("Hiker")

    response = client.get("/api/admin/stats", headers=auth_headers(hiker))

    assert response.status_code == 404
    assert response.json() == {"detail": "not_found"}
    assert client.get("/api/me", headers=auth_headers(hiker)).json()["is_admin"] is False


def test_signing_in_is_required(client: TestClient) -> None:
    assert client.get("/api/admin/stats").status_code == 401


def test_nobody_is_admin_by_default(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user()
    assert get_settings().admin_subjects == frozenset()
    assert client.get("/api/admin/stats", headers=auth_headers(user)).status_code == 404


def test_me_says_who_is_admin(client: TestClient, admin: User, auth_headers: AuthHeaders) -> None:
    assert client.get("/api/me", headers=auth_headers(admin)).json()["is_admin"] is True
    patched = client.patch("/api/me", json={"city": "Kranj"}, headers=auth_headers(admin))
    assert patched.json()["is_admin"] is True


def test_totals(
    client: TestClient,
    session: Session,
    admin: User,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
) -> None:
    long_ago = datetime.now(UTC) - timedelta(days=60)
    old = create_user("Old", locale="en", created_at=long_ago, last_seen_on=date(2020, 1, 1))
    create_user("New", locale=None)
    group = make_group(session, visibility=GroupVisibility.PUBLIC, admins=[admin], members=[old])
    make_guest(session, group)
    private = make_trail(session, admin, "Private", TrailVisibility.PRIVATE)
    make_trail(session, old, "Public", TrailVisibility.PUBLIC)
    archived = make_trail(session, admin, "Archived", TrailVisibility.PRIVATE)
    archived.archived_at = datetime.now(UTC)
    make_hike(session, private, None, users=[admin])
    session.add(
        GroupInvitation(
            group_id=group.id,
            email="friend@example.com",
            token_hash="x" * 64,
            invited_by=admin.id,
            status=InvitationStatus.PENDING,
            expires_at=datetime.now(UTC) + timedelta(days=7),
        )
    )
    session.commit()

    response = client.get("/api/admin/stats", headers=auth_headers(admin))

    assert response.status_code == 200
    stats = response.json()
    assert stats["users"] == {
        "total": 3,
        "new_7_days": 2,
        "new_30_days": 2,
        # The admin, seen with this request. "New" never made a request; "Old" long ago.
        "active_30_days": 1,
        "by_language": {"sl": 1, "en": 1, "unknown": 1},
    }
    content = stats["content"]
    assert content["trails"] == 3
    assert content["trails_by_source"] == {"manual": 3}
    assert content["trails_by_visibility"] == {"private": 2, "public": 1}
    assert content["trails_archived"] == 1
    assert content["hikes"] == 1
    assert content["groups"] == 1
    assert content["memberships"] == 2
    assert content["guests"] == 1
    assert content["pending_invitations"] == 1
    assert content["pending_join_requests"] == 0

    database = stats["database"]
    assert database["size_bytes"] > 0
    assert database["migration"] == "0004"
    names = [table["name"] for table in database["largest_tables"]]
    assert 0 < len(names) <= 8
    assert "users" in names or len(names) == 8

    server = stats["server"]
    assert server["version"] == "dev"
    assert server["environment"] == "development"
    assert server["today"] == datetime.now(UTC).date().isoformat()


def test_totals_show_no_personal_data(
    client: TestClient, admin: User, auth_headers: AuthHeaders
) -> None:
    body = client.get("/api/admin/stats", headers=auth_headers(admin)).text
    assert admin.email not in body
    assert admin.display_name not in body


def test_elevation_tiles_are_counted(
    client: TestClient,
    admin: User,
    auth_headers: AuthHeaders,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    (tmp_path / "a.tif").write_bytes(b"1234")
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "b.tiff").write_bytes(b"12")
    (tmp_path / "readme.txt").write_text("not a tile")
    monkeypatch.setattr(get_settings(), "dem_dir", str(tmp_path))

    server = client.get("/api/admin/stats", headers=auth_headers(admin)).json()["server"]

    assert server["elevation_data"] == {"tiles": 2, "size_bytes": 6}


def test_last_seen_is_the_day_of_the_last_request(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user(last_seen_on=date(2024, 5, 1))

    client.get("/api/me", headers=auth_headers(user))

    session.refresh(user)
    assert user.last_seen_on == datetime.now(UTC).date()


def test_new_users_are_seen_on_their_first_day(
    client: TestClient, session: Session, make_token: object
) -> None:
    token = make_token(subject="hanko-brand-new", email="new@example.com")  # type: ignore[operator]
    client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    user = session.query(User).filter_by(auth_subject="hanko-brand-new").one()
    assert user.last_seen_on == datetime.now(UTC).date()


def test_the_export_includes_the_last_day_seen(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    user = create_user()
    profile = client.get("/api/me/export", headers=auth_headers(user)).json()["profile"]
    assert profile["last_seen_on"] == datetime.now(UTC).date().isoformat()
