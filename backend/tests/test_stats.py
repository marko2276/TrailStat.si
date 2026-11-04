from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import GroupVisibility
from tests.conftest import AuthHeaders, CreateUser
from tests.test_hikes_factories import (
    delete_group,
    make_group,
    make_guest,
    make_hike,
    make_trail,
    remove_member,
)

ZERO = {
    "hike_count": 0,
    "total_distance_m": 0,
    "total_elevation_gain_m": 0,
    "total_duration_s": 0,
    "average_duration_s": 0,
}


def totals(count: int, distance: int, gain: int, duration: int, average: float) -> dict[str, Any]:
    return {
        "hike_count": count,
        "total_distance_m": distance,
        "total_elevation_gain_m": gain,
        "total_duration_s": duration,
        "average_duration_s": average,
    }


class World:
    """Hand-computed scenario. Trails: A 10 km/500 m, B 5 km/no elevation, C 8 km/300 m (archived).

    | hike | when (UTC)         | trail | time   | group | attendees          |
    |------|--------------------|-------|--------|-------|--------------------|
    | h1   | 2026-01-10 10:00   | A     | 3600 s | yes   | Alice, Bob, Gina   |
    | h2   | 2026-02-01 00:00   | B     | 1800 s | yes   | Alice, Carol       |
    | h3   | 2026-03-15 08:00   | C     | 5400 s | yes   | Gina (by Alice)    |
    | h4   | 2026-02-20 12:00   | A     | 7200 s | no    | Alice              |

    Carol leaves the group afterwards.
    """

    def __init__(self, session: Session, create_user: CreateUser):
        self.alice = create_user(display_name="Alice")
        self.bob = create_user(display_name="Bob")
        self.carol = create_user(display_name="Carol")
        self.outsider = create_user(display_name="Outsider")
        self.group = make_group(
            session, self.alice, [self.bob, self.carol], visibility=GroupVisibility.PUBLIC
        )
        self.gina = make_guest(session, self.group, "Gina")
        trail_a = make_trail(session, self.alice, distance_m=10_000, elevation_gain_m=500)
        trail_b = make_trail(session, self.alice, distance_m=5_000, elevation_gain_m=None)
        trail_c = make_trail(
            session, self.alice, distance_m=8_000, elevation_gain_m=300, archived=True
        )
        make_hike(
            session,
            trail_a,
            self.alice,
            self.group,
            users=[self.alice, self.bob],
            guests=[self.gina],
            start_at=datetime(2026, 1, 10, 10, 0, tzinfo=UTC),
            duration_s=3600,
        )
        make_hike(
            session,
            trail_b,
            self.bob,
            self.group,
            users=[self.alice, self.carol],
            start_at=datetime(2026, 2, 1, 0, 0, tzinfo=UTC),
            duration_s=1800,
        )
        make_hike(
            session,
            trail_c,
            self.alice,
            self.group,
            guests=[self.gina],
            start_at=datetime(2026, 3, 15, 8, 0, tzinfo=UTC),
            duration_s=5400,
        )
        make_hike(
            session,
            trail_a,
            self.alice,
            users=[self.alice],
            start_at=datetime(2026, 2, 20, 12, 0, tzinfo=UTC),
            duration_s=7200,
        )
        remove_member(session, self.group, self.carol)
        self.url = f"/api/stats/groups/{self.group.id}"


@pytest.fixture
def world(session: Session, create_user: CreateUser) -> World:
    return World(session, create_user)


class TestPersonal:
    def test_exact_totals_across_personal_and_group_hikes(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        # h1 + h2 + h4. Not h3: Alice recorded it, but didn't attend.
        body = client.get("/api/stats/me", headers=auth_headers(world.alice)).json()
        assert body == totals(3, 25_000, 1_000, 12_600, 4_200)

    def test_group_hike_counts_for_each_attending_member(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        body = client.get("/api/stats/me", headers=auth_headers(world.bob)).json()
        assert body == totals(1, 10_000, 500, 3_600, 3_600)

    def test_former_member_keeps_their_hikes_and_null_elevation_counts_as_zero(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        body = client.get("/api/stats/me", headers=auth_headers(world.carol)).json()
        assert body == totals(1, 5_000, 0, 1_800, 1_800)

    def test_no_hikes_gives_zeroes(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        body = client.get("/api/stats/me", headers=auth_headers(world.outsider)).json()
        assert body == ZERO

    def test_period_includes_start_and_excludes_end(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        headers = auth_headers(world.alice)

        def query(start_from: str, start_to: str) -> Any:
            return client.get(
                "/api/stats/me",
                headers=headers,
                params={"start_from": start_from, "start_to": start_to},
            ).json()

        # h2 is exactly at the start, h4 is later in the month.
        assert query("2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z") == totals(
            2, 15_000, 500, 9_000, 4_500
        )
        # The same period starting one second later loses h2.
        assert query("2026-02-01T00:00:01Z", "2026-03-01T00:00:00Z") == totals(
            1, 10_000, 500, 7_200, 7_200
        )
        # A period ending exactly at h2 doesn't include it: only h1.
        assert query("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z") == totals(
            1, 10_000, 500, 3_600, 3_600
        )
        # The same instant in another time zone: h2 is at 01:00 in Ljubljana.
        assert query("2026-02-01T01:00:00+01:00", "2026-02-01T01:00:01+01:00") == totals(
            1, 5_000, 0, 1_800, 1_800
        )
        assert query("2026-02-01T00:30:00+01:00", "2026-02-01T01:00:00+01:00") == ZERO

    def test_only_one_bound(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        headers = auth_headers(world.alice)
        since = client.get(
            "/api/stats/me", headers=headers, params={"start_from": "2026-02-10T00:00:00Z"}
        ).json()
        until = client.get(
            "/api/stats/me", headers=headers, params={"start_to": "2026-02-10T00:00:00Z"}
        ).json()
        assert since == totals(1, 10_000, 500, 7_200, 7_200)
        assert until == totals(2, 15_000, 500, 5_400, 2_700)

    @pytest.mark.parametrize(
        "query",
        ["start_from=2026-01-01T00:00:00", "start_to=2026-01-01T00:00:00", "start_from=nonsense"],
    )
    def test_period_must_include_a_time_zone(
        self,
        client: TestClient,
        auth_headers: AuthHeaders,
        world: World,
        query: str,
    ) -> None:
        headers = auth_headers(world.bob)
        assert client.get(f"/api/stats/me?{query}", headers=headers).status_code == 422
        assert client.get(f"{world.url}?{query}", headers=headers).status_code == 422

    def test_hike_of_a_deleted_group_still_counts(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: World
    ) -> None:
        delete_group(session, world.group)
        for user, expected in (
            (world.alice, totals(3, 25_000, 1_000, 12_600, 4_200)),
            (world.bob, totals(1, 10_000, 500, 3_600, 3_600)),
            (world.carol, totals(1, 5_000, 0, 1_800, 1_800)),
        ):
            assert client.get("/api/stats/me", headers=auth_headers(user)).json() == expected

    def test_average_is_not_rounded(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user = create_user()
        trail = make_trail(session, user)
        for duration_s in (100, 100, 101):
            make_hike(session, trail, user, users=[user], duration_s=duration_s)
        body = client.get("/api/stats/me", headers=auth_headers(user)).json()
        assert body["average_duration_s"] == pytest.approx(301 / 3)


class TestGroupSummary:
    def test_any_user_sees_totals_of_a_public_group(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        # h1 + h2 + h3, each once despite having several attendees. C is archived and counts;
        # B has no elevation.
        for user in (world.outsider, world.bob, world.carol):
            response = client.get(f"{world.url}/summary", headers=auth_headers(user))
            assert response.status_code == 200
            assert response.json() == totals(3, 23_000, 800, 10_800, 3_600)

    def test_private_group_is_hidden_from_non_members(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        member, outsider, former = create_user(), create_user(), create_user()
        group = make_group(session, member, [former])
        make_hike(session, make_trail(session, member), member, group, users=[member, former])
        url = f"/api/stats/groups/{group.id}"
        remove_member(session, group, former)

        assert client.get(f"{url}/summary", headers=auth_headers(member)).status_code == 200
        for user in (outsider, former):
            headers = auth_headers(user)
            assert client.get(f"{url}/summary", headers=headers).status_code == 404
            assert client.get(url, headers=headers).status_code == 404

    def test_empty_group(
        self,
        client: TestClient,
        session: Session,
        create_user: CreateUser,
        auth_headers: AuthHeaders,
    ) -> None:
        user = create_user()
        group = make_group(session, user)
        headers = auth_headers(user)
        url = f"/api/stats/groups/{group.id}"
        assert client.get(f"{url}/summary", headers=headers).json() == ZERO
        assert client.get(url, headers=headers).json() == {"totals": ZERO, "attendees": []}


def breakdown(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {row["name"]: row["totals"] for row in body["attendees"]}


class TestGroupFull:
    def test_members_only(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        assert client.get(world.url, headers=auth_headers(world.bob)).status_code == 200
        assert client.get(world.url, headers=auth_headers(world.outsider)).status_code == 403
        # A former member is a non-member, even if they appear in the statistics.
        assert client.get(world.url, headers=auth_headers(world.carol)).status_code == 403

    def test_totals_count_each_hike_once_with_exact_breakdown(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        body = client.get(world.url, headers=auth_headers(world.bob)).json()

        # Joining attendees would give 6 hikes and 48 km here.
        assert body["totals"] == totals(3, 23_000, 800, 10_800, 3_600)
        assert [row["name"] for row in body["attendees"]] == ["Alice", "Bob", "Carol", "Gina"]
        assert breakdown(body) == {
            # h1 + h2. Not the personal h4, and not h3, which Alice only recorded.
            "Alice": totals(2, 15_000, 500, 5_400, 2_700),
            "Bob": totals(1, 10_000, 500, 3_600, 3_600),
            # Left the group, still listed.
            "Carol": totals(1, 5_000, 0, 1_800, 1_800),
            # A guest, h1 + h3.
            "Gina": totals(2, 18_000, 800, 9_000, 4_500),
        }

    def test_attendee_ids(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        body = client.get(world.url, headers=auth_headers(world.bob)).json()
        identities = {row["name"]: (row["user_id"], row["guest_id"]) for row in body["attendees"]}
        assert identities["Bob"] == (str(world.bob.id), None)
        assert identities["Gina"] == (None, str(world.gina.id))

    def test_period_applies_to_totals_and_breakdown(
        self, client: TestClient, auth_headers: AuthHeaders, world: World
    ) -> None:
        def query(start_from: str, start_to: str) -> Any:
            return client.get(
                world.url,
                headers=auth_headers(world.bob),
                params={"start_from": start_from, "start_to": start_to},
            ).json()

        # h2 at the inclusive start; h3 exactly at the exclusive end.
        body = query("2026-02-01T00:00:00Z", "2026-03-15T08:00:00Z")
        assert body["totals"] == totals(1, 5_000, 0, 1_800, 1_800)
        assert breakdown(body) == {
            "Alice": totals(1, 5_000, 0, 1_800, 1_800),
            "Carol": totals(1, 5_000, 0, 1_800, 1_800),
        }

        body = query("2026-02-01T00:00:01Z", "2026-03-15T08:00:01Z")
        assert body["totals"] == totals(1, 8_000, 300, 5_400, 5_400)
        assert breakdown(body) == {"Gina": totals(1, 8_000, 300, 5_400, 5_400)}

        assert query("2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z") == {
            "totals": ZERO,
            "attendees": [],
        }

    def test_personal_and_other_groups_hikes_do_not_leak_in(
        self, client: TestClient, session: Session, auth_headers: AuthHeaders, world: World
    ) -> None:
        other = make_group(session, world.alice, [world.bob])
        make_hike(session, make_trail(session, world.alice), world.alice, other, users=[world.bob])
        body = client.get(world.url, headers=auth_headers(world.bob)).json()
        assert body["totals"]["hike_count"] == 3
        assert breakdown(body)["Bob"]["hike_count"] == 1
