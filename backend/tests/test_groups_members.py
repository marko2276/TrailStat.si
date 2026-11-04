"""Members, roles, the "at least one admin" rule, and guests."""

import threading
import time
import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, delete, select, text
from sqlalchemy.orm import Session

from app.db import get_session
from app.main import app
from app.models import (
    Group,
    GroupGuest,
    GroupMembership,
    GroupRole,
    GroupVisibility,
    Hike,
    HikeAttendee,
    TrailVisibility,
    User,
)
from tests.conftest import AuthHeaders, CreateUser
from tests.groups_helpers import make_group, make_guest, make_hike, make_trail


def role_of(session: Session, group: Group, user: User) -> GroupRole | None:
    session.expire_all()
    membership = session.get(GroupMembership, (group.id, user.id))
    return membership.role if membership else None


# Listing


def test_members_see_the_member_list_without_email_addresses(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user("Ana", email="ana@example.com")
    member = create_user("Bor", email="bor@example.com")
    group = make_group(session, admins=[admin], members=[member])

    response = client.get(f"/api/groups/{group.id}/members", headers=auth_headers(member))

    assert response.json() == {
        "items": [
            {"user_id": str(admin.id), "display_name": "Ana", "role": "admin"},
            {"user_id": str(member.id), "display_name": "Bor", "role": "member"},
        ]
    }
    assert "example.com" not in response.text


# Promote and demote


def test_admin_promotes_and_demotes(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin, member = create_user(), create_user("Bor")
    group = make_group(session, admins=[admin], members=[member])
    url = f"/api/groups/{group.id}/members/{member.id}"

    response = client.patch(url, json={"role": "admin"}, headers=auth_headers(admin))
    assert response.status_code == 200
    assert response.json() == {"user_id": str(member.id), "display_name": "Bor", "role": "admin"}
    assert role_of(session, group, member) == GroupRole.ADMIN

    response = client.patch(url, json={"role": "member"}, headers=auth_headers(admin))
    assert response.status_code == 200
    assert role_of(session, group, member) == GroupRole.MEMBER


def test_plain_member_cannot_promote_themselves_or_others(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member, other = create_user(), create_user()
    group = make_group(session, admins=[create_user()], members=[member, other])

    for target in (member, other):
        response = client.patch(
            f"/api/groups/{group.id}/members/{target.id}",
            json={"role": "admin"},
            headers=auth_headers(member),
        )
        assert response.status_code == 403
        assert role_of(session, group, target) == GroupRole.MEMBER


def test_changing_someone_outside_the_group_is_404(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])

    response = client.patch(
        f"/api/groups/{group.id}/members/{create_user().id}",
        json={"role": "admin"},
        headers=auth_headers(admin),
    )

    assert response.status_code == 404


# Last admin: all three paths


def test_last_admin_cannot_be_demoted(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin, member = create_user(), create_user()
    group = make_group(session, admins=[admin], members=[member])

    response = client.patch(
        f"/api/groups/{group.id}/members/{admin.id}",
        json={"role": "member"},
        headers=auth_headers(admin),
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "last_admin"
    assert role_of(session, group, admin) == GroupRole.ADMIN


def test_last_admin_cannot_be_removed(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin], members=[create_user()])

    response = client.delete(
        f"/api/groups/{group.id}/members/{admin.id}", headers=auth_headers(admin)
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "last_admin"
    assert role_of(session, group, admin) == GroupRole.ADMIN


def test_last_admin_cannot_leave(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin], members=[create_user()])

    response = client.post(f"/api/groups/{group.id}/leave", headers=auth_headers(admin))

    assert response.status_code == 409
    assert response.json()["detail"] == "last_admin"
    assert role_of(session, group, admin) == GroupRole.ADMIN


def test_with_a_second_admin_an_admin_can_leave_and_be_demoted(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    first, second, third = create_user(), create_user(), create_user()
    group = make_group(session, admins=[first, second, third])

    response = client.patch(
        f"/api/groups/{group.id}/members/{second.id}",
        json={"role": "member"},
        headers=auth_headers(first),
    )
    assert response.status_code == 200

    response = client.post(f"/api/groups/{group.id}/leave", headers=auth_headers(first))
    assert response.status_code == 204
    assert role_of(session, group, first) is None
    assert role_of(session, group, third) == GroupRole.ADMIN


def test_demoting_an_admin_cannot_be_used_on_a_plain_member_to_trip_the_rule(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin, member = create_user(), create_user()
    group = make_group(session, admins=[admin], members=[member])

    response = client.patch(
        f"/api/groups/{group.id}/members/{member.id}",
        json={"role": "member"},
        headers=auth_headers(admin),
    )

    assert response.status_code == 200


# Remove and leave


def test_admin_removes_a_member(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin, member = create_user(), create_user()
    group = make_group(session, admins=[admin], members=[member])

    response = client.delete(
        f"/api/groups/{group.id}/members/{member.id}", headers=auth_headers(admin)
    )

    assert response.status_code == 204
    assert role_of(session, group, member) is None


def test_plain_member_cannot_remove_anyone(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin, member, other = create_user(), create_user(), create_user()
    group = make_group(session, admins=[admin], members=[member, other])

    for target in (other, admin):
        response = client.delete(
            f"/api/groups/{group.id}/members/{target.id}", headers=auth_headers(member)
        )
        assert response.status_code == 403
    assert role_of(session, group, other) == GroupRole.MEMBER


def test_member_leaves(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member = create_user()
    group = make_group(session, admins=[create_user()], members=[member])

    response = client.post(f"/api/groups/{group.id}/leave", headers=auth_headers(member))

    assert response.status_code == 204
    assert role_of(session, group, member) is None


def test_outsider_cannot_leave_a_public_group(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    group = make_group(session, visibility=GroupVisibility.PUBLIC)

    response = client.post(f"/api/groups/{group.id}/leave", headers=auth_headers(create_user()))

    assert response.status_code == 403


@pytest.mark.parametrize("how", ["leave", "remove"])
def test_leaving_keeps_past_hikes_attendance_and_trails(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    how: str,
) -> None:
    admin, member = create_user(), create_user()
    group = make_group(session, admins=[admin], members=[member])
    trail = make_trail(session, member, "Shared", TrailVisibility.GROUP, group)
    hike = make_hike(session, trail, group, users=[admin, member])

    if how == "leave":
        client.post(f"/api/groups/{group.id}/leave", headers=auth_headers(member))
    else:
        client.delete(f"/api/groups/{group.id}/members/{member.id}", headers=auth_headers(admin))

    session.expire_all()
    assert role_of(session, group, member) is None
    assert hike.group_id == group.id
    assert {attendee.user_id for attendee in hike.attendees} == {admin.id, member.id}
    assert trail.visibility == TrailVisibility.GROUP
    assert trail.group_id == group.id
    assert trail.owner_user_id == member.id


# The race: two admins demote each other at once


@pytest.fixture
def real_sessions(test_engine: Engine) -> Iterator[None]:
    """Every request gets its own connection, with real commits, as in production."""

    def _session() -> Iterator[Session]:
        with Session(test_engine) as session:
            yield session

    app.dependency_overrides[get_session] = _session
    yield
    app.dependency_overrides.pop(get_session, None)


def test_two_admins_demoting_each_other_leaves_one_admin(
    test_engine: Engine, real_sessions: None, auth_headers: AuthHeaders
) -> None:
    with Session(test_engine) as setup:
        first = User(auth_subject=f"race-{uuid.uuid4()}", email="a@e.si", display_name="A")
        second = User(auth_subject=f"race-{uuid.uuid4()}", email="b@e.si", display_name="B")
        setup.add_all([first, second])
        setup.flush()
        group = make_group(setup, admins=[first, second])
        group_id, first_id, second_id = group.id, first.id, second.id
        pairs = [(auth_headers(first), second_id), (auth_headers(second), first_id)]
        setup.commit()

    client = TestClient(app)
    responses: list[int] = []

    def demote(headers: dict[str, str], target: uuid.UUID) -> None:
        response = client.patch(
            f"/api/groups/{group_id}/members/{target}", json={"role": "member"}, headers=headers
        )
        responses.append(response.status_code)

    try:
        # Hold the group's row, so that both requests get to their lock before either proceeds.
        # Without locking they would not wait, and the check below would time out.
        with test_engine.connect() as holder:
            holder.execute(
                text("SELECT id FROM groups WHERE id = :id FOR UPDATE"), {"id": group_id}
            )
            threads = [threading.Thread(target=demote, args=pair) for pair in pairs]
            for thread in threads:
                thread.start()
            with test_engine.connect() as observer:
                observer = observer.execution_options(isolation_level="AUTOCOMMIT")
                deadline = time.monotonic() + 15
                waiting = 0
                while waiting < 2 and time.monotonic() < deadline:
                    waiting = (
                        observer.scalar(
                            text(
                                "SELECT count(*) FROM pg_stat_activity "
                                "WHERE wait_event_type = 'Lock' AND datname = current_database()"
                            )
                        )
                        or 0
                    )
                    time.sleep(0.05)
            holder.rollback()
            for thread in threads:
                thread.join(timeout=30)

        assert waiting == 2, "the requests did not wait for the group's lock"
        assert sorted(responses) == [200, 403]
        with Session(test_engine) as check:
            admins = check.scalars(
                select(GroupMembership).where(
                    GroupMembership.group_id == group_id,
                    GroupMembership.role == GroupRole.ADMIN,
                )
            ).all()
            assert len(admins) == 1
    finally:
        with Session(test_engine) as cleanup:
            cleanup.execute(delete(Group).where(Group.id == group_id))
            cleanup.execute(delete(User).where(User.id.in_([first_id, second_id])))
            cleanup.commit()


# Guests


def test_any_member_adds_a_guest_with_a_trimmed_nickname(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member = create_user()
    group = make_group(session, admins=[create_user()], members=[member])

    response = client.post(
        f"/api/groups/{group.id}/guests",
        json={"nickname": "  Uncle\nBob "},
        headers=auth_headers(member),
    )

    assert response.status_code == 201
    assert response.json()["nickname"] == "Uncle Bob"
    listed = client.get(f"/api/groups/{group.id}/guests", headers=auth_headers(member)).json()
    assert listed == {"items": [{"id": response.json()["id"], "nickname": "Uncle Bob"}]}
    assert set(listed["items"][0]) == {"id", "nickname"}


@pytest.mark.parametrize(
    ("nickname", "code"),
    [("   ", "guest_name_required"), ("x" * 101, "guest_name_too_long")],
)
def test_guest_nickname_is_validated(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    nickname: str,
    code: str,
) -> None:
    member = create_user()
    group = make_group(session, members=[member])

    response = client.post(
        f"/api/groups/{group.id}/guests", json={"nickname": nickname}, headers=auth_headers(member)
    )

    assert response.status_code == 422
    assert response.json()["detail"] == code


@pytest.mark.parametrize("nickname", ["Uncle Bob", "uncle bob", "UNCLE BOB", " Uncle  Bob "])
def test_guest_nickname_is_unique_ignoring_case(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    nickname: str,
) -> None:
    member = create_user()
    group = make_group(session, members=[member])
    make_guest(session, group, "Uncle Bob")

    response = client.post(
        f"/api/groups/{group.id}/guests", json={"nickname": nickname}, headers=auth_headers(member)
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "guest_name_taken"


def test_non_ascii_nicknames_compare_ignoring_case(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member = create_user()
    group = make_group(session, members=[member])
    make_guest(session, group, "Špela")

    response = client.post(
        f"/api/groups/{group.id}/guests", json={"nickname": "špela"}, headers=auth_headers(member)
    )

    assert response.status_code == 409


def test_same_nickname_is_fine_in_another_group(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member = create_user()
    group = make_group(session, members=[member])
    make_guest(session, make_group(session, name="Other"), "Uncle Bob")

    response = client.post(
        f"/api/groups/{group.id}/guests",
        json={"nickname": "Uncle Bob"},
        headers=auth_headers(member),
    )

    assert response.status_code == 201


def test_admin_renames_a_guest(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    guest = make_guest(session, group, "Bob")
    url = f"/api/groups/{group.id}/guests/{guest.id}"
    headers = auth_headers(admin)

    # Only changing the case of their own name is not a conflict.
    assert client.patch(url, json={"nickname": "BOB"}, headers=headers).status_code == 200
    response = client.patch(url, json={"nickname": " Robert "}, headers=headers)

    assert response.status_code == 200
    assert response.json() == {"id": str(guest.id), "nickname": "Robert"}


def test_renaming_a_guest_to_a_taken_name_fails(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    make_guest(session, group, "Ana")
    guest = make_guest(session, group, "Bob")

    response = client.patch(
        f"/api/groups/{group.id}/guests/{guest.id}",
        json={"nickname": "ana"},
        headers=auth_headers(admin),
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "guest_name_taken"


def test_rename_keeps_the_hike_attendance(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    guest = make_guest(session, group, "Bob")
    trail = make_trail(session, admin, "T", TrailVisibility.GROUP, group)
    hike = make_hike(session, trail, group, guests=[guest])

    client.patch(
        f"/api/groups/{group.id}/guests/{guest.id}",
        json={"nickname": "Robert"},
        headers=auth_headers(admin),
    )

    session.expire_all()
    attendee = hike.attendees[0]
    assert attendee.guest_id == guest.id
    assert attendee.guest is not None
    assert attendee.guest.nickname == "Robert"


def test_plain_member_cannot_rename_or_remove_guests(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member = create_user()
    group = make_group(session, admins=[create_user()], members=[member])
    guest = make_guest(session, group, "Bob")
    url = f"/api/groups/{group.id}/guests/{guest.id}"
    headers = auth_headers(member)

    assert client.patch(url, json={"nickname": "X"}, headers=headers).status_code == 403
    assert client.delete(url, headers=headers).status_code == 403
    session.expire_all()
    assert guest.nickname == "Bob"


def test_removing_a_guest_removes_their_attendance_but_not_the_hike(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    guest = make_guest(session, group, "Bob")
    trail = make_trail(session, admin, "T", TrailVisibility.GROUP, group)
    hike = make_hike(session, trail, group, users=[admin], guests=[guest])

    response = client.delete(
        f"/api/groups/{group.id}/guests/{guest.id}", headers=auth_headers(admin)
    )

    assert response.status_code == 204
    session.expire_all()
    assert session.get(GroupGuest, guest.id) is None
    attendees = session.scalars(select(HikeAttendee).where(HikeAttendee.hike_id == hike.id)).all()
    assert [attendee.user_id for attendee in attendees] == [admin.id]


def test_removing_the_only_attendee_of_a_hike_removes_the_hike_from_the_totals(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    guest = make_guest(session, group, "Bob")
    other_guest = make_guest(session, group, "Ann")
    trail = make_trail(session, admin, "T", TrailVisibility.GROUP, group)
    alone = make_hike(session, trail, group, guests=[guest])
    together = make_hike(session, trail, group, guests=[guest, other_guest])
    without_them = make_hike(session, trail, group, guests=[other_guest])
    headers = auth_headers(admin)

    response = client.delete(f"/api/groups/{group.id}/guests/{guest.id}", headers=headers)

    assert response.status_code == 204
    session.expire_all()
    assert session.get(Hike, alone.id) is None
    assert session.get(Hike, together.id) is not None
    assert session.get(Hike, without_them.id) is not None
    summary = client.get(f"/api/stats/groups/{group.id}/summary", headers=headers).json()
    assert summary["hike_count"] == 2


def test_a_guest_of_another_group_is_404(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    foreign = make_guest(session, make_group(session, name="Other"), "Bob")
    url = f"/api/groups/{group.id}/guests/{foreign.id}"
    headers = auth_headers(admin)

    assert client.patch(url, json={"nickname": "X"}, headers=headers).status_code == 404
    assert client.delete(url, headers=headers).status_code == 404
