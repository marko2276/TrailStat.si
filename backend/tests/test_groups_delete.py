"""Deleting a group: what happens to its trails, hikes, guests and everything else."""

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    Group,
    GroupGuest,
    GroupInvitation,
    GroupMembership,
    GroupVisibility,
    Hike,
    HikeAttendee,
    JoinRequest,
    JoinRequestStatus,
    Trail,
    TrailVisibility,
    User,
)
from tests.conftest import AuthHeaders, CreateUser, FakeSender
from tests.groups_helpers import make_group, make_guest, make_hike, make_trail, token_in


def delete_group(
    client: TestClient, session: Session, group: Group, admin: User, auth_headers: AuthHeaders
) -> None:
    response = client.delete(f"/api/groups/{group.id}", headers=auth_headers(admin))
    assert response.status_code == 204, response.text
    session.expire_all()


def test_plain_member_and_outsider_cannot_delete(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    member = create_user()
    group = make_group(
        session, visibility=GroupVisibility.PUBLIC, admins=[create_user()], members=[member]
    )

    for user in (member, create_user()):
        response = client.delete(f"/api/groups/{group.id}", headers=auth_headers(user))
        assert response.status_code == 403
    session.expire_all()
    assert session.get(Group, group.id) is not None


def test_admin_deletes_the_group_and_what_belongs_to_it(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    outbox: FakeSender,
) -> None:
    admin, member, requester = create_user(), create_user(), create_user()
    group = make_group(session, admins=[admin], members=[member])
    group_id = group.id
    guest_id = make_guest(session, group).id
    session.add(
        JoinRequest(group_id=group.id, user_id=requester.id, status=JoinRequestStatus.PENDING)
    )
    session.commit()
    client.post(
        f"/api/groups/{group.id}/invitations",
        json={"email": "a@b.si"},
        headers=auth_headers(admin),
    )
    token = token_in(outbox.messages[0])

    delete_group(client, session, group, admin, auth_headers)

    assert session.get(Group, group_id) is None
    assert session.get(GroupGuest, guest_id) is None
    for model in (GroupMembership, GroupInvitation, JoinRequest):
        assert session.scalars(select(model).where(model.group_id == group_id)).all() == []
    assert client.get(f"/api/groups/{group_id}", headers=auth_headers(admin)).status_code == 404
    # The link in the e-mail says so.
    assert (
        client.get(f"/api/groups/invitations/{token}", headers=auth_headers(admin)).status_code
        == 404
    )


def test_shared_trail_becomes_private_to_its_creator(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin, creator = create_user(), create_user()
    group = make_group(session, admins=[admin], members=[creator])
    trail = make_trail(session, creator, "Triglav", TrailVisibility.GROUP, group)

    delete_group(client, session, group, admin, auth_headers)

    assert trail.visibility == TrailVisibility.PRIVATE
    assert trail.group_id is None
    assert trail.owner_user_id == creator.id
    assert trail.name == "Triglav"


def test_trails_of_other_groups_and_visibilities_are_untouched(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    other = make_group(session, name="Other", admins=[admin])
    in_other = make_trail(session, admin, "In other", TrailVisibility.GROUP, other)
    public = make_trail(session, admin, "Public one", TrailVisibility.PUBLIC)

    delete_group(client, session, group, admin, auth_headers)

    assert in_other.group_id == other.id
    assert public.visibility == TrailVisibility.PUBLIC


def test_name_clash_with_a_private_trail_gets_the_group_name_added(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, name="Hikers", admins=[admin])
    existing = make_trail(session, admin, "triglav")
    trail = make_trail(session, admin, "Triglav", TrailVisibility.GROUP, group)

    delete_group(client, session, group, admin, auth_headers)

    assert trail.name == "Triglav (Hikers)"
    assert trail.visibility == TrailVisibility.PRIVATE
    assert existing.name == "triglav"


def test_clash_with_the_suffixed_name_too_is_numbered(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, name="Hikers", admins=[admin])
    make_trail(session, admin, "Triglav")
    make_trail(session, admin, "Triglav (Hikers)")
    make_trail(session, admin, "Triglav (Hikers 2)")
    trail = make_trail(session, admin, "Triglav", TrailVisibility.GROUP, group)

    delete_group(client, session, group, admin, auth_headers)

    assert trail.name == "Triglav (Hikers 3)"


def test_clash_between_two_trails_of_the_group_itself(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    """ "A" and "A (Hikers)" both in the group, while the owner also has a private "A"."""
    admin = create_user()
    group = make_group(session, name="Hikers", admins=[admin])
    make_trail(session, admin, "A")
    first = make_trail(session, admin, "A", TrailVisibility.GROUP, group)
    second = make_trail(session, admin, "A (Hikers)", TrailVisibility.GROUP, group)

    delete_group(client, session, group, admin, auth_headers)

    # Whichever goes first takes "A (Hikers)", and the other has to make way. Rows made in one
    # transaction, as here, have the same created_at, so the order is not fixed.
    assert (first.name, second.name) in [
        ("A (Hikers)", "A (Hikers) (Hikers)"),
        ("A (Hikers 2)", "A (Hikers)"),
    ]
    assert first.visibility == second.visibility == TrailVisibility.PRIVATE


def test_archived_trails_count_as_clashes_and_stay_archived(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, name="Hikers", admins=[admin])
    archived = make_trail(session, admin, "Old")
    archived.archived_at = archived.created_at
    trail = make_trail(session, admin, "Old", TrailVisibility.GROUP, group)
    trail.archived_at = trail.created_at
    session.commit()

    delete_group(client, session, group, admin, auth_headers)

    assert trail.name == "Old (Hikers)"
    assert trail.archived_at is not None


def test_a_long_name_with_a_suffix_fits_the_column(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, name="G" * 100, admins=[admin])
    long_name = "T" * 200
    make_trail(session, admin, long_name)
    trail = make_trail(session, admin, long_name, TrailVisibility.GROUP, group)

    delete_group(client, session, group, admin, auth_headers)

    assert len(trail.name) == 200
    assert trail.name.endswith(f" ({'G' * 100})")


def test_same_name_for_different_owners_needs_no_suffix(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin, other = create_user(), create_user()
    group = make_group(session, admins=[admin])
    make_trail(session, other, "Triglav")
    trail = make_trail(session, admin, "Triglav", TrailVisibility.GROUP, group)

    delete_group(client, session, group, admin, auth_headers)

    assert trail.name == "Triglav"


def test_ownerless_trail_becomes_public(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    trail = make_trail(session, None, "Orphan", TrailVisibility.GROUP, group)

    delete_group(client, session, group, admin, auth_headers)

    assert trail.visibility == TrailVisibility.PUBLIC
    assert trail.group_id is None
    assert trail.owner_user_id is None
    assert trail.name == "Orphan"


def test_ownerless_trail_with_a_taken_public_name_gets_the_suffix(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, name="Hikers", admins=[admin])
    make_trail(session, admin, "ORPHAN", TrailVisibility.PUBLIC)
    trail = make_trail(session, None, "Orphan", TrailVisibility.GROUP, group)

    delete_group(client, session, group, admin, auth_headers)

    assert trail.name == "Orphan (Hikers)"
    assert trail.visibility == TrailVisibility.PUBLIC


def test_hikes_stay_with_their_user_attendees_and_lose_guests(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin, member = create_user(), create_user()
    group = make_group(session, admins=[admin], members=[member])
    guest = make_guest(session, group)
    trail = make_trail(session, admin, "T", TrailVisibility.GROUP, group)
    hike = make_hike(session, trail, group, users=[admin, member], guests=[guest])

    delete_group(client, session, group, admin, auth_headers)

    assert hike.group_id is None
    assert hike.trail_id == trail.id
    assert {attendee.user_id for attendee in hike.attendees} == {admin.id, member.id}
    assert all(attendee.guest_id is None for attendee in hike.attendees)


def test_hike_with_only_guests_is_deleted(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    guest = make_guest(session, group)
    trail = make_trail(session, admin, "T", TrailVisibility.GROUP, group)
    hike_id = make_hike(session, trail, group, guests=[guest]).id

    delete_group(client, session, group, admin, auth_headers)

    assert session.scalar(select(Hike).where(Hike.id == hike_id)) is None
    assert session.scalars(select(HikeAttendee).where(HikeAttendee.hike_id == hike_id)).all() == []
    # The trail stays, even with no hikes left.
    assert session.get(Trail, trail.id) is not None


def test_hikes_outside_the_group_are_untouched(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    admin = create_user()
    group = make_group(session, admins=[admin])
    other = make_group(session, name="Other", admins=[admin])
    other_guest = make_guest(session, other)
    trail = make_trail(session, admin, "T")
    personal = make_hike(session, trail, None, users=[admin])
    other_group_hike = make_hike(session, trail, other, guests=[other_guest])

    delete_group(client, session, group, admin, auth_headers)

    assert session.get(Hike, personal.id) is not None
    assert session.get(Hike, other_group_hike.id) is not None
    assert other_group_hike.group_id == other.id


def test_delete_with_everything_at_once(
    client: TestClient, session: Session, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    """The trail a kept hike refers to changes, and the hike still works."""
    admin = create_user()
    group = make_group(session, name="Hikers", admins=[admin])
    guest = make_guest(session, group)
    make_trail(session, admin, "T")
    trail = make_trail(session, admin, "T", TrailVisibility.GROUP, group)
    kept = make_hike(session, trail, group, users=[admin], guests=[guest])
    gone_id = make_hike(session, trail, group, guests=[guest]).id

    delete_group(client, session, group, admin, auth_headers)

    assert kept.trail.name == "T (Hikers)"
    assert len(kept.attendees) == 1
    assert session.scalar(select(Hike).where(Hike.id == gone_id)) is None
