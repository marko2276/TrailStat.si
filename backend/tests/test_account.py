from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

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
    Trail,
    TrailSource,
    TrailVisibility,
    User,
)
from tests.conftest import AuthHeaders, CreateUser


def group_with(
    session: Session,
    admins: tuple[User, ...] = (),
    members: tuple[User, ...] = (),
) -> Group:
    group = Group(name="Hikers", visibility=GroupVisibility.PRIVATE)
    session.add(group)
    session.flush()
    for user in admins:
        session.add(GroupMembership(group_id=group.id, user_id=user.id, role=GroupRole.ADMIN))
    for user in members:
        session.add(GroupMembership(group_id=group.id, user_id=user.id, role=GroupRole.MEMBER))
    session.commit()
    return group


def trail_of(
    session: Session,
    owner: User,
    name: str,
    visibility: TrailVisibility = TrailVisibility.PRIVATE,
    group: Group | None = None,
) -> Trail:
    trail = Trail(
        name=name,
        description="my notes",
        visibility=visibility,
        owner_user_id=owner.id,
        group_id=group.id if group else None,
        source=TrailSource.MANUAL,
        distance_m=1000,
    )
    session.add(trail)
    session.commit()
    return trail


def hike_on(
    session: Session,
    trail: Trail,
    users: tuple[User, ...],
    group: Group | None = None,
    guests: tuple[GroupGuest, ...] = (),
    notes: str | None = None,
) -> Hike:
    hike = Hike(
        trail_id=trail.id,
        group_id=group.id if group else None,
        recorded_by=users[0].id if users else None,
        start_at=datetime(2026, 5, 1, 8, tzinfo=UTC),
        duration_s=3600,
        notes=notes,
    )
    session.add(hike)
    session.flush()
    for user in users:
        session.add(HikeAttendee(hike_id=hike.id, user_id=user.id))
    for guest in guests:
        session.add(HikeAttendee(hike_id=hike.id, guest_id=guest.id))
    session.commit()
    return hike


def delete_me(client: TestClient, headers: dict[str, str]) -> None:
    assert client.delete("/api/me", headers=headers).status_code == 204


def test_export_needs_sign_in_and_delete_too(client: TestClient) -> None:
    assert client.get("/api/me/export").status_code == 401
    assert client.delete("/api/me").status_code == 401


def test_export_contains_my_data_and_not_other_peoples(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me = create_user(display_name="Me", email="me@example.com", city="Bled")
    other = create_user(display_name="Secret Other", email="other@example.com")
    group = group_with(session, admins=(me,), members=(other,))
    mine = trail_of(session, me, "My trail")
    trail_of(session, other, "Their trail", TrailVisibility.PUBLIC)
    hike_on(session, mine, (me,), notes="Nice day")
    shared = trail_of(session, me, "Shared", TrailVisibility.GROUP, group)
    hike_on(session, shared, (me, other), group)
    hike_on(session, shared, (other,), group, notes="Without me")

    response = client.get("/api/me/export", headers=auth_headers(me))

    assert response.status_code == 200
    data = response.json()
    assert data["profile"]["email"] == "me@example.com"
    assert data["profile"]["city"] == "Bled"
    assert {trail["name"] for trail in data["trails"]} == {"My trail", "Shared"}
    assert len(data["hikes"]) == 2
    assert {hike["notes"] for hike in data["hikes"]} == {"Nice day", None}
    assert {hike["group"] for hike in data["hikes"]} == {None, "Hikers"}
    assert data["groups"][0]["role"] == "admin"
    text = response.text
    assert "Secret Other" not in text
    assert "other@example.com" not in text
    assert "Their trail" not in text
    assert "Without me" not in text


def test_deleting_removes_the_profile_and_private_data(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me = create_user(email="me@example.com")
    me_id = me.id
    trail = trail_of(session, me, "Private")
    trail_id = trail.id
    hike_id = hike_on(session, trail, (me,), notes="Private note").id

    delete_me(client, auth_headers(me))

    session.expire_all()
    assert session.get(User, me_id) is None
    assert session.get(Hike, hike_id) is None
    assert session.get(Trail, trail_id) is None


def test_others_keep_a_shared_hike_without_my_name(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me, other = create_user(display_name="Gone"), create_user(display_name="Stays")
    group = group_with(session, admins=(other,), members=(me,))
    trail = trail_of(session, other, "T", TrailVisibility.GROUP, group)
    hike = hike_on(session, trail, (me, other), group)
    url = f"/api/hikes/{hike.id}"

    delete_me(client, auth_headers(me))

    session.expire_all()
    response = client.get(url, headers=auth_headers(other))
    assert response.status_code == 200
    assert [attendee["name"] for attendee in response.json()["attendees"]] == ["Stays"]
    assert response.json()["recorded_by"] is None
    assert "Gone" not in response.text


def test_a_hike_only_i_attended_goes_even_in_a_group_and_totals_follow(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me, other = create_user(), create_user()
    group = group_with(session, admins=(other,), members=(me,))
    trail = trail_of(session, other, "T", TrailVisibility.GROUP, group)
    hike_id = hike_on(session, trail, (me,), group).id
    guest = GroupGuest(group_id=group.id, nickname="Bob")
    session.add(guest)
    session.commit()
    with_guest = hike_on(session, trail, (me,), group, guests=(guest,)).id

    delete_me(client, auth_headers(me))

    session.expire_all()
    assert session.get(Hike, hike_id) is None
    assert session.get(Hike, with_guest) is not None
    summary = client.get(f"/api/stats/groups/{group.id}/summary", headers=auth_headers(other))
    assert summary.json()["hike_count"] == 1


def test_trails_others_rely_on_stay_without_an_owner(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me, other = create_user(display_name="Gone"), create_user()
    group = group_with(session, admins=(other,), members=(me,))
    public = trail_of(session, me, "Public", TrailVisibility.PUBLIC)
    shared = trail_of(session, me, "Shared", TrailVisibility.GROUP, group)
    public_id, shared_id = public.id, shared.id

    delete_me(client, auth_headers(me))

    session.expire_all()
    assert session.get(Trail, public_id).owner_user_id is None  # type: ignore[union-attr]
    assert session.get(Trail, shared_id).owner_user_id is None  # type: ignore[union-attr]
    body = client.get(f"/api/trails/{public_id}", headers=auth_headers(other))
    assert body.status_code == 200
    assert body.json()["owner_name"] is None
    assert body.json()["can_edit"] is False


def test_a_private_trail_on_someone_elses_hike_stays_hidden_without_my_notes(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me, other = create_user(), create_user()
    trail = trail_of(session, me, "Was public", TrailVisibility.PUBLIC)
    hike = hike_on(session, trail, (other,))
    trail.visibility = TrailVisibility.PRIVATE
    session.commit()
    trail_id = trail.id

    delete_me(client, auth_headers(me))

    session.expire_all()
    kept = session.get(Trail, trail_id)
    assert kept is not None
    assert kept.owner_user_id is None
    assert kept.description is None
    assert client.get(f"/api/trails/{trail_id}", headers=auth_headers(other)).status_code == 404
    response = client.get(f"/api/hikes/{hike.id}", headers=auth_headers(other))
    assert response.json()["trail"]["name"] == "Was public"


def test_the_longest_standing_member_takes_over_from_the_last_admin(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me, newer, older = create_user(), create_user(), create_user()
    group = group_with(session, admins=(me,), members=(newer, older))
    session.get(GroupMembership, (group.id, older.id)).joined_at = datetime(  # type: ignore[union-attr]
        2020, 1, 1, tzinfo=UTC
    )
    session.commit()

    delete_me(client, auth_headers(me))

    session.expire_all()
    assert session.get(GroupMembership, (group.id, older.id)).role == GroupRole.ADMIN  # type: ignore[union-attr]
    assert session.get(GroupMembership, (group.id, newer.id)).role == GroupRole.MEMBER  # type: ignore[union-attr]


def test_no_one_is_promoted_when_another_admin_remains(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me, admin, member = create_user(), create_user(), create_user()
    group = group_with(session, admins=(me, admin), members=(member,))

    delete_me(client, auth_headers(me))

    session.expire_all()
    assert session.get(GroupMembership, (group.id, member.id)).role == GroupRole.MEMBER  # type: ignore[union-attr]


def test_a_group_with_no_one_else_is_deleted_and_its_rules_apply(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me = create_user()
    group = group_with(session, admins=(me,))
    group_id = group.id
    trail_id = trail_of(session, me, "Shared", TrailVisibility.GROUP, group).id

    delete_me(client, auth_headers(me))

    session.expire_all()
    assert session.get(Group, group_id) is None
    assert session.get(Trail, trail_id) is None


def test_invitations_to_my_address_are_removed_and_those_i_sent_stay(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me, admin = create_user(email="Me@Example.com"), create_user()
    group = group_with(session, admins=(admin, me))
    for email, inviter, token in (
        ("me@example.com", admin, "a" * 64),
        ("friend@example.com", me, "b" * 64),
    ):
        session.add(
            GroupInvitation(
                group_id=group.id,
                email=email,
                token_hash=token,
                invited_by=inviter.id,
                status=InvitationStatus.PENDING,
                expires_at=datetime(2030, 1, 1, tzinfo=UTC),
            )
        )
    session.commit()

    delete_me(client, auth_headers(me))

    session.expire_all()
    left = session.scalars(select(GroupInvitation)).all()
    assert [(item.email, item.invited_by) for item in left] == [("friend@example.com", None)]


def test_deleting_leaves_other_users_data_alone(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    me, other = create_user(), create_user()
    trail = trail_of(session, other, "Theirs")
    hike_id = hike_on(session, trail, (other,)).id

    delete_me(client, auth_headers(me))

    session.expire_all()
    assert session.get(Hike, hike_id) is not None
    assert session.scalar(select(func.count()).select_from(User).where(User.id == other.id)) == 1
