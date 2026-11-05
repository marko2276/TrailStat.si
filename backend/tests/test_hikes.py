import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, event, func, select
from sqlalchemy.orm import Session

from app.main import app
from app.models import (
    GroupMembership,
    GroupRole,
    GroupVisibility,
    Hike,
    HikeAttendee,
    TrailVisibility,
    User,
)
from app.schemas.hikes import MAX_DURATION_S
from tests.conftest import AuthHeaders, CreateUser, run_held_back
from tests.test_hikes_factories import (
    PAST,
    delete_group,
    make_group,
    make_guest,
    make_hike,
    make_trail,
    remove_member,
)

START = "2026-01-15T09:00:00+01:00"


def new_hike(trail_id: uuid.UUID, **fields: Any) -> dict[str, Any]:
    return {"trail_id": str(trail_id), "start_at": START, "duration_s": 3600, **fields}


def ids(*rows: Any) -> list[str]:
    return [str(row.id) for row in rows]


@pytest.fixture
def post(client: TestClient, auth_headers: AuthHeaders) -> Callable[..., Any]:
    def _post(user: User, trail_id: uuid.UUID, **fields: Any) -> Any:
        return client.post(
            "/api/hikes", headers=auth_headers(user), json=new_hike(trail_id, **fields)
        )

    return _post


class TestPersonalHikeRecording:
    def test_records_with_the_recorder_as_only_attendee(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        user = create_user(display_name="Marko")
        trail = make_trail(session, user, distance_m=12_345, elevation_gain_m=678)

        response = post(user, trail.id, notes="  Lovely day  ")

        assert response.status_code == 201
        body = response.json()
        assert body["trail"] == {
            "id": str(trail.id),
            "name": trail.name,
            "distance_m": 12_345,
            "elevation_gain_m": 678,
            "archived": False,
        }
        assert body["group_id"] is None
        assert body["group_name"] is None
        assert body["recorded_by"] == str(user.id)
        assert datetime.fromisoformat(body["start_at"]) == datetime(2026, 1, 15, 8, 0, tzinfo=UTC)
        assert body["duration_s"] == 3600
        assert body["notes"] == "Lovely day"
        assert body["attendees"] == [{"user_id": str(user.id), "guest_id": None, "name": "Marko"}]
        assert body["can_edit"] is True
        assert body["can_delete"] is True

    def test_rejects_other_attendees(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        user, other = create_user(), create_user()
        trail = make_trail(session, user)
        guest = make_guest(session, make_group(session, user))

        assert post(user, trail.id, attendee_user_ids=ids(other)).status_code == 422
        response = post(user, trail.id, attendee_guest_ids=ids(guest))
        assert response.status_code == 422
        assert response.json()["detail"] == "personal_hike_attendees"
        assert post(user, trail.id, attendee_user_ids=ids(user)).status_code == 201

    @pytest.mark.parametrize(
        "start_at",
        ["2026-01-15T09:00:00", "2026-01-15", "not a date", "1850-01-01T00:00:00Z", None],
    )
    def test_rejects_invalid_start(
        self, post: Any, session: Session, create_user: CreateUser, start_at: str | None
    ) -> None:
        user = create_user()
        response = post(user, make_trail(session, user).id, start_at=start_at)
        assert response.status_code == 422

    def test_start_may_not_be_in_the_future_beyond_a_small_tolerance(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)
        now = datetime.now(UTC)

        response = post(user, trail.id, start_at=(now + timedelta(hours=1)).isoformat())
        assert response.status_code == 422
        assert response.json()["detail"] == "start_at_in_future"
        response = post(user, trail.id, start_at=(now + timedelta(minutes=1)).isoformat())
        assert response.status_code == 201

    def test_future_check_compares_instants_not_clock_time(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)
        # An hour ago, written in a zone whose clock reads ahead of UTC's current time.
        start = (datetime.now(UTC) - timedelta(hours=1)).astimezone(timezone(timedelta(hours=10)))
        assert post(user, trail.id, start_at=start.isoformat()).status_code == 201

    @pytest.mark.parametrize("duration_s", [0, -1, MAX_DURATION_S + 1, 1.5, None])
    def test_rejects_invalid_duration(
        self, post: Any, session: Session, create_user: CreateUser, duration_s: Any
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)
        assert post(user, trail.id, duration_s=duration_s).status_code == 422

    def test_longest_allowed_duration(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)
        assert post(user, trail.id, duration_s=MAX_DURATION_S).status_code == 201

    def test_trail_must_be_visible(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        user, other = create_user(), create_user()
        private = make_trail(session, other, TrailVisibility.PRIVATE)
        other_group = make_group(session, other)
        shared = make_trail(session, other, TrailVisibility.GROUP, other_group)

        assert post(user, private.id).status_code == 404
        assert post(user, shared.id).status_code == 404
        assert post(user, uuid.uuid4()).status_code == 404
        assert post(other, private.id).status_code == 201

    def test_archived_trail_cannot_be_chosen(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        user = create_user()
        response = post(user, make_trail(session, user, archived=True).id)
        assert response.status_code == 422
        assert response.json()["detail"] == "trail_archived"

    def test_needs_sign_in(
        self, client: TestClient, session: Session, create_user: CreateUser
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)
        assert client.post("/api/hikes", json=new_hike(trail.id)).status_code == 401
        assert client.get("/api/hikes").status_code == 401


class TestPersonalHikeOwnership:
    def test_owner_reads_edits_and_deletes(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user = create_user()
        trail, other_trail = make_trail(session, user), make_trail(session, user)
        hike = make_hike(session, trail, user, users=[user])
        hike_id = hike.id
        url = f"/api/hikes/{hike_id}"
        headers = auth_headers(user)

        assert client.get(url, headers=headers).status_code == 200
        response = client.patch(
            url,
            headers=headers,
            json={
                "trail_id": str(other_trail.id),
                "start_at": START,
                "duration_s": 7200,
                "notes": "Changed",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["trail"]["id"] == str(other_trail.id)
        assert body["duration_s"] == 7200
        assert body["notes"] == "Changed"

        response = client.patch(url, headers=headers, json={"notes": None})
        assert response.json()["notes"] is None
        assert response.json()["duration_s"] == 7200

        assert client.delete(url, headers=headers).status_code == 204
        assert client.get(url, headers=headers).status_code == 404
        assert session.get(Hike, hike_id) is None

    def test_other_users_get_404(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user, other = create_user(), create_user()
        hike = make_hike(session, make_trail(session, user), user, users=[user])
        url = f"/api/hikes/{hike.id}"
        headers = auth_headers(other)

        assert client.get(url, headers=headers).status_code == 404
        assert client.patch(url, headers=headers, json={"notes": "x"}).status_code == 404
        assert client.delete(url, headers=headers).status_code == 404
        assert session.get(Hike, hike.id) is not None

    def test_edit_rejects_other_attendees_and_group_change(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user, other = create_user(), create_user()
        group = make_group(session, user)
        hike = make_hike(session, make_trail(session, user), user, users=[user])
        url = f"/api/hikes/{hike.id}"
        headers = auth_headers(user)

        for change in (
            {"attendee_user_ids": ids(other)},
            {"attendee_guest_ids": ids(make_guest(session, group))},
            {"group_id": str(group.id)},
        ):
            assert client.patch(url, headers=headers, json=change).status_code == 422
        assert client.get(url, headers=headers).json()["group_id"] is None

    @pytest.mark.parametrize(
        "change",
        [
            {"trail_id": None},
            {"start_at": None},
            {"duration_s": None},
            {"attendee_user_ids": None},
            {"duration_s": 0},
            {"start_at": "2026-01-15T09:00:00"},
            {"start_at": "2999-01-15T09:00:00Z"},
        ],
    )
    def test_edit_validates_like_recording(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
        change: dict[str, Any],
    ) -> None:
        user = create_user()
        hike = make_hike(session, make_trail(session, user), user, users=[user])
        response = client.patch(f"/api/hikes/{hike.id}", headers=auth_headers(user), json=change)
        assert response.status_code == 422

    def test_hike_on_a_now_archived_trail_stays_editable(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user = create_user()
        archived = make_trail(session, user, archived=True)
        other_archived = make_trail(session, user, archived=True)
        active = make_trail(session, user)
        hike = make_hike(session, archived, user, users=[user])
        url = f"/api/hikes/{hike.id}"
        headers = auth_headers(user)

        response = client.patch(url, headers=headers, json={"notes": "Still here"})
        assert response.status_code == 200
        assert response.json()["trail"]["archived"] is True
        # Sending the same trail back is not choosing a new one.
        same = client.patch(url, headers=headers, json={"trail_id": str(archived.id)})
        assert same.status_code == 200

        response = client.patch(url, headers=headers, json={"trail_id": str(other_archived.id)})
        assert response.status_code == 422
        assert response.json()["detail"] == "trail_archived"

        moved = client.patch(url, headers=headers, json={"trail_id": str(active.id)})
        assert moved.json()["trail"]["archived"] is False

    def test_rejected_edit_changes_nothing(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user = create_user()
        archived = make_trail(session, user, archived=True)
        hike = make_hike(session, make_trail(session, user), user, users=[user], duration_s=3600)
        url = f"/api/hikes/{hike.id}"
        headers = auth_headers(user)

        response = client.patch(
            url, headers=headers, json={"duration_s": 60, "trail_id": str(archived.id)}
        )

        assert response.status_code == 422
        assert client.get(url, headers=headers).json()["duration_s"] == 3600


class TestGroupHikeRecording:
    def test_any_member_records_with_chosen_attendees(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin = create_user(display_name="Ana")
        member = create_user(display_name="Bor")
        group = make_group(session, admin, [member])
        guest = make_guest(session, group, "Cene")
        trail = make_trail(session, admin)

        response = post(
            member,
            trail.id,
            group_id=str(group.id),
            attendee_user_ids=ids(admin, member),
            attendee_guest_ids=ids(guest),
        )

        assert response.status_code == 201
        body = response.json()
        assert body["group_id"] == str(group.id)
        assert body["group_name"] == group.name
        assert body["recorded_by"] == str(member.id)
        assert body["attendees"] == [
            {"user_id": str(admin.id), "guest_id": None, "name": "Ana"},
            {"user_id": str(member.id), "guest_id": None, "name": "Bor"},
            {"user_id": None, "guest_id": str(guest.id), "name": "Cene"},
        ]

    def test_recorder_does_not_have_to_attend(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin, member = create_user(), create_user()
        group = make_group(session, admin, [member])
        response = post(
            member,
            make_trail(session, admin).id,
            group_id=str(group.id),
            attendee_user_ids=ids(admin),
        )
        assert response.status_code == 201
        assert [a["user_id"] for a in response.json()["attendees"]] == [str(admin.id)]

    def test_repeated_attendees_count_once(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin = create_user()
        group = make_group(session, admin)
        response = post(
            admin,
            make_trail(session, admin).id,
            group_id=str(group.id),
            attendee_user_ids=ids(admin, admin),
        )
        assert response.status_code == 201
        assert len(response.json()["attendees"]) == 1

    def test_outsiders_cannot_record(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin, outsider = create_user(), create_user()
        trail = make_trail(session, admin)
        private = make_group(session, admin)
        public = make_group(session, admin, visibility=GroupVisibility.PUBLIC)

        for group, status in ((private, 404), (public, 403)):
            response = post(
                outsider, trail.id, group_id=str(group.id), attendee_user_ids=ids(admin)
            )
            assert response.status_code == status

    def test_needs_at_least_one_attendee(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin = create_user()
        group = make_group(session, admin)
        response = post(admin, make_trail(session, admin).id, group_id=str(group.id))
        assert response.status_code == 422
        assert response.json()["detail"] == "attendees_required"

    def test_guest_counts_as_the_one_attendee(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin = create_user()
        group = make_group(session, admin)
        guest = make_guest(session, group)
        response = post(
            admin,
            make_trail(session, admin).id,
            group_id=str(group.id),
            attendee_guest_ids=ids(guest),
        )
        assert response.status_code == 201

    def test_rejects_non_member_attendee(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin, outsider = create_user(), create_user()
        group = make_group(session, admin)
        response = post(
            admin,
            make_trail(session, admin).id,
            group_id=str(group.id),
            attendee_user_ids=ids(admin, outsider),
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "attendee_not_member"

    def test_rejects_guest_of_another_group(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin = create_user()
        group, other_group = make_group(session, admin), make_group(session, admin)
        foreign_guest = make_guest(session, other_group)
        response = post(
            admin,
            make_trail(session, admin).id,
            group_id=str(group.id),
            attendee_user_ids=ids(admin),
            attendee_guest_ids=ids(foreign_guest),
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "guest_not_in_group"

    def test_trail_must_be_visible_to_the_group(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin = create_user()
        group, other_group = make_group(session, admin), make_group(session, admin)
        fields = {"group_id": str(group.id), "attendee_user_ids": ids(admin)}

        for not_for_group in (
            make_trail(session, admin, TrailVisibility.PRIVATE),
            make_trail(session, admin, TrailVisibility.GROUP, other_group),
        ):
            response = post(admin, not_for_group.id, **fields)
            assert response.status_code == 422
            assert response.json()["detail"] == "trail_not_visible_to_group"

        assert post(admin, make_trail(session, admin).id, **fields).status_code == 201
        shared = make_trail(session, admin, TrailVisibility.GROUP, group)
        assert post(admin, shared.id, **fields).status_code == 201

    def test_trail_must_also_be_visible_to_the_recorder(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin, member = create_user(), create_user()
        group = make_group(session, admin, [member])
        private_to_admin = make_trail(session, admin, TrailVisibility.PRIVATE)
        response = post(
            member, private_to_admin.id, group_id=str(group.id), attendee_user_ids=ids(member)
        )
        assert response.status_code == 404

    def test_archived_trail_cannot_be_chosen(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        admin = create_user()
        group = make_group(session, admin)
        response = post(
            admin,
            make_trail(session, admin, archived=True).id,
            group_id=str(group.id),
            attendee_user_ids=ids(admin),
        )
        assert response.json()["detail"] == "trail_archived"


class GroupWorld:
    """An admin, a recorder and a plain member in a group, plus an outsider and a hike."""

    def __init__(self, session: Session, create_user: CreateUser, visibility: GroupVisibility):
        self.admin = create_user(display_name="Admin")
        self.recorder = create_user(display_name="Recorder")
        self.member = create_user(display_name="Member")
        self.outsider = create_user(display_name="Outsider")
        self.group = make_group(
            session, self.admin, [self.recorder, self.member], visibility=visibility
        )
        self.trail = make_trail(session, self.admin)
        self.hike = make_hike(
            session, self.trail, self.recorder, self.group, users=[self.recorder, self.member]
        )
        self.hike_id = self.hike.id
        self.url = f"/api/hikes/{self.hike.id}"


@pytest.fixture
def world(session: Session, create_user: CreateUser) -> GroupWorld:
    return GroupWorld(session, create_user, GroupVisibility.PRIVATE)


class TestGroupHikeEditAndDelete:
    @pytest.mark.parametrize(
        ("who", "status"), [("admin", 200), ("recorder", 200), ("member", 403), ("outsider", 404)]
    )
    def test_who_can_edit(
        self,
        client: TestClient,
        auth_headers: AuthHeaders,
        world: GroupWorld,
        who: str,
        status: int,
    ) -> None:
        headers = auth_headers(getattr(world, who))
        response = client.patch(world.url, headers=headers, json={"notes": "Edited"})
        assert response.status_code == status

    @pytest.mark.parametrize(
        ("who", "status"), [("admin", 204), ("recorder", 403), ("member", 403), ("outsider", 404)]
    )
    def test_who_can_delete(
        self,
        client: TestClient,
        session: Session,
        auth_headers: AuthHeaders,
        world: GroupWorld,
        who: str,
        status: int,
    ) -> None:
        response = client.delete(world.url, headers=auth_headers(getattr(world, who)))
        assert response.status_code == status
        assert (session.get(Hike, world.hike_id) is None) == (status == 204)

    @pytest.mark.parametrize(
        ("who", "can_edit", "can_delete"),
        [("admin", True, True), ("recorder", True, False), ("member", False, False)],
    )
    def test_flags_per_user(
        self,
        client: TestClient,
        auth_headers: AuthHeaders,
        world: GroupWorld,
        who: str,
        can_edit: bool,
        can_delete: bool,
    ) -> None:
        body = client.get(world.url, headers=auth_headers(getattr(world, who))).json()
        assert (body["can_edit"], body["can_delete"]) == (can_edit, can_delete)

    def test_recorder_who_left_can_no_longer_edit(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        remove_member(session, world.group, world.recorder)
        headers = auth_headers(world.recorder)

        body = client.get(world.url, headers=headers).json()
        assert (body["can_edit"], body["can_delete"]) == (False, False)
        assert client.patch(world.url, headers=headers, json={"notes": "x"}).status_code == 403
        assert client.delete(world.url, headers=headers).status_code == 403

    def test_recorder_who_left_without_attending_loses_the_hike(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        hike = make_hike(session, world.trail, world.recorder, world.group, users=[world.member])
        url = f"/api/hikes/{hike.id}"
        remove_member(session, world.group, world.recorder)
        assert client.get(url, headers=auth_headers(world.recorder)).status_code == 404

    def test_trail_change_uses_the_group_rule(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        private = make_trail(session, world.recorder, TrailVisibility.PRIVATE)
        response = client.patch(
            world.url, headers=auth_headers(world.recorder), json={"trail_id": str(private.id)}
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "trail_not_visible_to_group"


class TestGroupHikeAttendeeEdits:
    def test_replaces_attendees(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        guest = make_guest(session, world.group, "Gost")
        response = client.patch(
            world.url,
            headers=auth_headers(world.admin),
            json={"attendee_user_ids": ids(world.admin), "attendee_guest_ids": ids(guest)},
        )
        assert response.status_code == 200
        assert {(a["user_id"], a["guest_id"]) for a in response.json()["attendees"]} == {
            (str(world.admin.id), None),
            (None, str(guest.id)),
        }

    def test_changing_only_users_keeps_guests(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        guest = make_guest(session, world.group)
        hike = make_hike(
            session, world.trail, world.admin, world.group, users=[world.member], guests=[guest]
        )
        response = client.patch(
            f"/api/hikes/{hike.id}",
            headers=auth_headers(world.admin),
            json={"attendee_user_ids": []},
        )
        assert response.status_code == 200
        assert [a["guest_id"] for a in response.json()["attendees"]] == [str(guest.id)]

    def test_removing_everyone_is_rejected(
        self, client: TestClient, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        response = client.patch(
            world.url, headers=auth_headers(world.admin), json={"attendee_user_ids": []}
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "attendees_required"

    def test_newly_added_attendees_are_validated(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        headers = auth_headers(world.admin)
        foreign_guest = make_guest(session, make_group(session, world.admin))

        response = client.patch(
            world.url, headers=headers, json={"attendee_user_ids": ids(world.outsider)}
        )
        assert response.json()["detail"] == "attendee_not_member"

        response = client.patch(
            world.url, headers=headers, json={"attendee_guest_ids": ids(foreign_guest)}
        )
        assert response.json()["detail"] == "guest_not_in_group"

        attendees = client.get(world.url, headers=headers).json()["attendees"]
        assert {a["user_id"] for a in attendees} == {str(world.recorder.id), str(world.member.id)}

    def test_past_attendee_stays_valid_but_cannot_be_added_again(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        remove_member(session, world.group, world.member)
        headers = auth_headers(world.admin)
        both = ids(world.recorder, world.member)

        # Other fields, and the same attendee list, still work.
        assert client.patch(world.url, headers=headers, json={"notes": "x"}).status_code == 200
        response = client.patch(world.url, headers=headers, json={"attendee_user_ids": both})
        assert response.status_code == 200
        assert {a["name"] for a in response.json()["attendees"]} == {"Recorder", "Member"}

        # Once removed from the hike, they are a new attendee and no longer a member.
        response = client.patch(
            world.url, headers=headers, json={"attendee_user_ids": ids(world.recorder)}
        )
        assert response.status_code == 200
        response = client.patch(world.url, headers=headers, json={"attendee_user_ids": both})
        assert response.status_code == 422
        assert response.json()["detail"] == "attendee_not_member"


class TestGroupHikeVisibility:
    def test_members_see_any_hike_of_their_group(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        not_attended = make_hike(
            session, world.trail, world.admin, world.group, users=[world.admin]
        )
        response = client.get(f"/api/hikes/{not_attended.id}", headers=auth_headers(world.member))
        assert response.status_code == 200

    def test_outsider_of_a_public_group_cannot_see_hikes(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        public = GroupWorld(session, create_user, GroupVisibility.PUBLIC)
        headers = auth_headers(public.outsider)
        assert client.get(public.url, headers=headers).status_code == 404
        response = client.get(f"/api/groups/{public.group.id}/hikes", headers=headers)
        assert response.status_code == 403

    def test_group_list_is_for_members(
        self,
        client: TestClient,
        session: Session,
        auth_headers: AuthHeaders,
        world: GroupWorld,
    ) -> None:
        url = f"/api/groups/{world.group.id}/hikes"
        assert client.get(url, headers=auth_headers(world.outsider)).status_code == 404

        make_hike(session, world.trail, world.admin, world.group, users=[world.admin])
        body = client.get(url, headers=auth_headers(world.member)).json()
        assert body["total"] == 2

    def test_former_member_keeps_attended_hikes_only(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        not_attended = make_hike(
            session, world.trail, world.admin, world.group, users=[world.admin]
        )
        not_attended_url = f"/api/hikes/{not_attended.id}"
        group_url = f"/api/groups/{world.group.id}/hikes"
        remove_member(session, world.group, world.member)
        headers = auth_headers(world.member)

        assert client.get(world.url, headers=headers).status_code == 200
        assert client.get(not_attended_url, headers=headers).status_code == 404
        listed = client.get("/api/hikes", headers=headers).json()
        assert [item["id"] for item in listed["items"]] == [str(world.hike_id)]
        assert client.get(group_url, headers=headers).status_code == 404


class TestHikeWhoseGroupWasDeleted:
    def test_shared_hike_keeps_everyones_history(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        delete_group(session, world.group)
        recorder_headers = auth_headers(world.recorder)
        member_headers = auth_headers(world.member)

        for headers in (recorder_headers, member_headers):
            body = client.get(world.url, headers=headers).json()
            assert body["group_id"] is None
            assert body["group_name"] is None
            assert (body["can_edit"], body["can_delete"]) == (False, True)
            assert client.patch(world.url, headers=headers, json={"notes": "x"}).status_code == 403

        # The first attendee removes only their own attendance.
        assert client.delete(world.url, headers=member_headers).status_code == 204
        assert client.get(world.url, headers=member_headers).status_code == 404
        assert client.get("/api/hikes", headers=member_headers).json()["total"] == 0
        assert session.get(Hike, world.hike_id) is not None

        # The last one left owns it outright: can edit, and deleting removes the row.
        body = client.get(world.url, headers=recorder_headers).json()
        assert [a["name"] for a in body["attendees"]] == ["Recorder"]
        assert (body["can_edit"], body["can_delete"]) == (True, True)
        response = client.patch(world.url, headers=recorder_headers, json={"notes": "x"})
        assert response.status_code == 200
        assert client.delete(world.url, headers=recorder_headers).status_code == 204
        assert session.get(Hike, world.hike_id) is None
        attendance = select(HikeAttendee).where(HikeAttendee.hike_id == world.hike_id)
        assert session.scalars(attendance).first() is None

    def test_sole_attendee_recorded_by_someone_else_owns_it(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        hike = make_hike(session, world.trail, world.admin, world.group, users=[world.member])
        hike_id = hike.id
        delete_group(session, world.group)
        url = f"/api/hikes/{hike_id}"
        headers = auth_headers(world.member)

        body = client.get(url, headers=headers).json()
        assert (body["can_edit"], body["can_delete"]) == (True, True)
        assert client.patch(url, headers=headers, json={"duration_s": 60}).status_code == 200
        assert client.delete(url, headers=headers).status_code == 204
        assert session.get(Hike, hike_id) is None

    def test_recorder_who_did_not_attend_and_former_admin_lose_access(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        hike = make_hike(session, world.trail, world.admin, world.group, users=[world.member])
        url = f"/api/hikes/{hike.id}"
        delete_group(session, world.group)
        headers = auth_headers(world.admin)

        assert client.get(url, headers=headers).status_code == 404
        assert client.patch(url, headers=headers, json={"notes": "x"}).status_code == 404
        assert client.delete(url, headers=headers).status_code == 404

    def test_guests_are_gone_and_personal_rules_apply_to_edits(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        guest = make_guest(session, world.group)
        hike = make_hike(
            session, world.trail, world.admin, world.group, users=[world.member], guests=[guest]
        )
        url = f"/api/hikes/{hike.id}"
        delete_group(session, world.group)
        headers = auth_headers(world.member)

        body = client.get(url, headers=headers).json()
        assert [a["name"] for a in body["attendees"]] == ["Member"]
        assert body["can_edit"] is True
        response = client.patch(url, headers=headers, json={"attendee_user_ids": ids(world.admin)})
        assert response.status_code == 422
        assert response.json()["detail"] == "personal_hike_attendees"


class TestLists:
    def test_my_list_has_attended_hikes_newest_first(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user, other = create_user(), create_user()
        trail = make_trail(session, user)
        group = make_group(session, user, [other])
        older = make_hike(session, trail, user, users=[user], start_at=PAST)
        newer = make_hike(
            session, trail, other, group, users=[user], start_at=PAST + timedelta(days=1)
        )
        make_hike(session, trail, user, group, users=[other], start_at=PAST + timedelta(days=2))

        body = client.get("/api/hikes", headers=auth_headers(user)).json()

        assert [item["id"] for item in body["items"]] == [str(newer.id), str(older.id)]
        assert (body["total"], body["limit"], body["offset"]) == (2, 50, 0)

    def test_paging(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)
        hikes = [
            make_hike(session, trail, user, users=[user], start_at=PAST + timedelta(days=day))
            for day in range(3)
        ]
        headers = auth_headers(user)

        body = client.get("/api/hikes?limit=2&offset=2", headers=headers).json()

        assert [item["id"] for item in body["items"]] == [str(hikes[0].id)]
        assert (body["total"], body["limit"], body["offset"]) == (3, 2, 2)
        for query in ("limit=0", "limit=201", "offset=-1"):
            assert client.get(f"/api/hikes?{query}", headers=headers).status_code == 422

    @pytest.mark.parametrize("group_list", [False, True])
    def test_period_includes_start_and_excludes_end(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
        group_list: bool,
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)
        group = make_group(session, user)
        start = datetime(2026, 3, 1, 0, 0, tzinfo=UTC)
        end = datetime(2026, 4, 1, 0, 0, tzinfo=UTC)
        moments = {
            "before": start - timedelta(seconds=1),
            "at_start": start,
            "last_second": end - timedelta(seconds=1),
            "at_end": end,
        }
        made = {
            label: make_hike(session, trail, user, group, users=[user], start_at=moment)
            for label, moment in moments.items()
        }
        url = f"/api/groups/{group.id}/hikes" if group_list else "/api/hikes"

        response = client.get(
            url,
            headers=auth_headers(user),
            params={"start_from": start.isoformat(), "start_to": end.isoformat()},
        )

        assert [item["id"] for item in response.json()["items"]] == [
            str(made["last_second"].id),
            str(made["at_start"].id),
        ]
        assert response.json()["total"] == 2

    def test_period_must_include_a_time_zone(
        self, client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
    ) -> None:
        headers = auth_headers(create_user())
        for query in ("start_from=2026-01-01T00:00:00", "start_to=2026-01-01T00:00:00"):
            assert client.get(f"/api/hikes?{query}", headers=headers).status_code == 422

    def test_list_flags_are_per_user(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: GroupWorld
    ) -> None:
        other_group = make_group(session, world.member, [world.admin])
        make_hike(session, world.trail, world.member, other_group, users=[world.member])
        items = client.get("/api/hikes", headers=auth_headers(world.member)).json()["items"]
        flags = {item["group_id"]: (item["can_edit"], item["can_delete"]) for item in items}
        assert flags == {str(world.group.id): (False, False), str(other_group.id): (True, True)}


def test_lists_do_not_run_a_query_per_hike(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
) -> None:
    user, other = create_user(), create_user()
    group = make_group(session, user, [other])
    guest = make_guest(session, group)
    headers = auth_headers(user)
    group_id = group.id

    def add_hikes(count: int) -> None:
        for _ in range(count):
            # A different trail each time, so nothing can be served from the identity map.
            make_hike(
                session,
                make_trail(session, user),
                user,
                group,
                users=[user, other],
                guests=[guest],
            )

    def queries(url: str) -> int:
        session.expire_all()
        statements: list[str] = []

        def record(_conn: Connection, _cursor: Any, statement: str, *_rest: Any) -> None:
            statements.append(statement)

        connection = session.connection()
        event.listen(connection, "before_cursor_execute", record)
        response = client.get(url, headers=headers)
        event.remove(connection, "before_cursor_execute", record)
        assert response.status_code == 200
        return len(statements)

    add_hikes(2)
    urls = ("/api/hikes", f"/api/groups/{group_id}/hikes")
    before = [queries(url) for url in urls]
    add_hikes(8)
    assert [queries(url) for url in urls] == before


class TestFormerMember:
    """They keep their history, without what the group keeps private."""

    @pytest.fixture
    def setup(self, session: Session, create_user: CreateUser) -> Any:
        admin = create_user(display_name="Admin")
        former = create_user(display_name="Former")
        other = create_user(display_name="Other")
        group = make_group(session, admin, members=[former, other])
        guest = make_guest(session, group, nickname="Secret guest")
        trail = make_trail(session, admin, TrailVisibility.GROUP, group, distance_m=7_000)
        hike = make_hike(session, trail, other, group, users=[former, other], guests=[guest])
        hike.notes = "Private to the group"
        session.commit()
        remove_member(session, group, former)
        return SimpleNamespace(
            admin=admin, former=former, other=other, group=group, trail=trail, hike=hike
        )

    def expected(self, setup: Any) -> dict[str, Any]:
        return {
            "id": str(setup.hike.id),
            "trail": {
                "id": str(setup.trail.id),
                "name": setup.trail.name,
                "distance_m": 7_000,
                "elevation_gain_m": 500,
                "archived": False,
            },
            "group_id": None,
            "group_name": None,
            "recorded_by": None,
            "start_at": PAST.isoformat().replace("+00:00", "Z"),
            "duration_s": 3600,
            "notes": None,
            "attendees": [{"user_id": str(setup.former.id), "guest_id": None, "name": "Former"}],
            "can_edit": False,
            "can_delete": False,
        }

    def test_read_one_shows_only_their_own_part(
        self, client: TestClient, auth_headers: AuthHeaders, setup: Any
    ) -> None:
        response = client.get(f"/api/hikes/{setup.hike.id}", headers=auth_headers(setup.former))

        assert response.status_code == 200
        assert response.json() == self.expected(setup)

    def test_list_shows_only_their_own_part(
        self, client: TestClient, auth_headers: AuthHeaders, setup: Any
    ) -> None:
        response = client.get("/api/hikes", headers=auth_headers(setup.former))

        assert response.json()["total"] == 1
        assert response.json()["items"] == [self.expected(setup)]

    def test_statistics_still_count_it(
        self, client: TestClient, auth_headers: AuthHeaders, setup: Any
    ) -> None:
        totals = client.get("/api/stats/me", headers=auth_headers(setup.former)).json()

        assert (totals["hike_count"], totals["total_distance_m"]) == (1, 7_000)

    def test_cannot_edit_or_delete_it(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, setup: Any
    ) -> None:
        url = f"/api/hikes/{setup.hike.id}"
        headers = auth_headers(setup.former)

        assert client.patch(url, json={"notes": "x"}, headers=headers).status_code == 403
        assert client.delete(url, headers=headers).status_code == 403
        session.expire_all()
        assert setup.hike.notes == "Private to the group"

    def test_current_members_still_see_everything(
        self, client: TestClient, auth_headers: AuthHeaders, setup: Any
    ) -> None:
        body = client.get(f"/api/hikes/{setup.hike.id}", headers=auth_headers(setup.other)).json()

        assert body["group_id"] == str(setup.group.id)
        assert body["notes"] == "Private to the group"
        assert {attendee["name"] for attendee in body["attendees"]} == {
            "Former",
            "Other",
            "Secret guest",
        }

    def test_coming_back_restores_the_view(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, setup: Any
    ) -> None:
        session.add(
            GroupMembership(group_id=setup.group.id, user_id=setup.former.id, role=GroupRole.MEMBER)
        )
        session.commit()

        body = client.get(f"/api/hikes/{setup.hike.id}", headers=auth_headers(setup.former)).json()

        assert body["notes"] == "Private to the group"
        assert len(body["attendees"]) == 3

    def test_export_has_only_their_own_part_too(
        self, client: TestClient, auth_headers: AuthHeaders, setup: Any
    ) -> None:
        export = client.get("/api/me/export", headers=auth_headers(setup.former)).json()

        assert [(hike["group"], hike["notes"]) for hike in export["hikes"]] == [(None, None)]
        assert export["hikes"][0]["trail"] == setup.trail.name


class TestControlCharactersInNotes:
    def test_nul_is_refused_when_recording(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)

        assert post(user, trail.id, notes="a\x00b").status_code == 422

    def test_nul_is_refused_when_editing(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user = create_user()
        hike = make_hike(session, make_trail(session, user), user, users=[user])

        response = client.patch(
            f"/api/hikes/{hike.id}", json={"notes": "a\x00b"}, headers=auth_headers(user)
        )

        assert response.status_code == 422

    def test_notes_may_have_several_lines(
        self, post: Any, session: Session, create_user: CreateUser
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)

        response = post(user, trail.id, notes="first\nsecond\ttab")

        assert response.status_code == 201
        assert response.json()["notes"] == "first\nsecond\ttab"


class TestConcurrentChanges:
    """With real connections and commits. Never a hike with nobody on it."""

    def attendee_count(self, engine: Engine, hike_id: uuid.UUID) -> int:
        with Session(engine) as check:
            count = check.scalar(
                select(func.count())
                .select_from(HikeAttendee)
                .where(HikeAttendee.hike_id == hike_id)
            )
        return count or 0

    def test_two_edits_keeping_different_attendees(
        self, test_engine: Engine, real_user: CreateUser, auth_headers: AuthHeaders
    ) -> None:
        admin, first, second = real_user(), real_user(), real_user()
        with Session(test_engine) as setup:
            group = make_group(setup, admin, members=[first, second])
            trail = make_trail(setup, admin, TrailVisibility.GROUP, group)
            hike = make_hike(setup, trail, admin, group, users=[first, second])
            hike_id = hike.id
        client = TestClient(app)
        statuses: list[int] = []

        def keep(user: User) -> Callable[[], None]:
            def call() -> None:
                response = client.patch(
                    f"/api/hikes/{hike_id}",
                    json={"attendee_user_ids": [str(user.id)]},
                    headers=auth_headers(admin),
                )
                statuses.append(response.status_code)

            return call

        waiting = run_held_back(test_engine, "hikes", hike_id, [keep(first), keep(second)])

        assert waiting == 2, "the requests did not wait for the hike's lock"
        assert statuses == [200, 200]
        assert self.attendee_count(test_engine, hike_id) == 1

    def test_two_attendees_removing_themselves(
        self, test_engine: Engine, real_user: CreateUser, auth_headers: AuthHeaders
    ) -> None:
        first, second = real_user(), real_user()
        with Session(test_engine) as setup:
            trail = make_trail(setup, first)
            hike = make_hike(setup, trail, first, users=[first, second])
            hike_id = hike.id
        client = TestClient(app)
        statuses: list[int] = []

        def remove(user: User) -> Callable[[], None]:
            def call() -> None:
                response = client.delete(f"/api/hikes/{hike_id}", headers=auth_headers(user))
                statuses.append(response.status_code)

            return call

        waiting = run_held_back(test_engine, "hikes", hike_id, [remove(first), remove(second)])

        assert waiting == 2, "the requests did not wait for the hike's lock"
        assert statuses == [204, 204]
        with Session(test_engine) as check:
            assert check.get(Hike, hike_id) is None
        assert self.attendee_count(test_engine, hike_id) == 0

    def test_two_admins_deleting_a_group_hike(
        self, test_engine: Engine, real_user: CreateUser, auth_headers: AuthHeaders
    ) -> None:
        first, second = real_user(), real_user()
        with Session(test_engine) as setup:
            group = make_group(setup, first)
            setup.add(GroupMembership(group_id=group.id, user_id=second.id, role=GroupRole.ADMIN))
            setup.commit()
            trail = make_trail(setup, first, TrailVisibility.GROUP, group)
            hike = make_hike(setup, trail, first, group, users=[first])
            hike_id = hike.id
        client = TestClient(app)
        statuses: list[int] = []

        def remove(user: User) -> Callable[[], None]:
            def call() -> None:
                response = client.delete(f"/api/hikes/{hike_id}", headers=auth_headers(user))
                statuses.append(response.status_code)

            return call

        waiting = run_held_back(test_engine, "hikes", hike_id, [remove(first), remove(second)])

        assert waiting == 2, "the requests did not wait for the hike's lock"
        assert sorted(statuses) == [204, 404]

    def test_a_duplicate_attendee_is_a_conflict_not_a_crash(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The lock prevents this between edits. Anything else that adds an attendee could still
        get in first, so it is simulated here, right before the commit."""
        admin = create_user()
        member = create_user()
        member_id = member.id
        group = make_group(session, admin, members=[member])
        trail = make_trail(session, admin, TrailVisibility.GROUP, group)
        hike = make_hike(session, trail, admin, group, users=[member])
        hike_id = hike.id

        def add_again(_session: Session, target: Hike, *_args: Any) -> None:
            target.attendees.append(HikeAttendee(user_id=member_id))

        monkeypatch.setattr("app.api.hikes._apply_group_attendees", add_again)

        response = client.patch(
            f"/api/hikes/{hike_id}",
            json={"attendee_user_ids": [str(member_id)]},
            headers=auth_headers(admin),
        )

        assert (response.status_code, response.json()["detail"]) == (409, "hike_changed")
        count = session.scalar(
            select(func.count()).select_from(HikeAttendee).where(HikeAttendee.hike_id == hike_id)
        )
        assert count == 1
