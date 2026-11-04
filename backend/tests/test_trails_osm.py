"""OSM search, preview and import. Overpass is always a mocked transport, never the network."""

import json
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import from_origin
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.api.trails import get_overpass_client
from app.config import get_settings
from app.main import app
from app.models import Group, GroupMembership, GroupRole, GroupVisibility, Trail, User
from app.services.geo import Coord, line_length_m
from app.services.osm import (
    USER_AGENT,
    BoundingBox,
    OverpassClient,
    WayMember,
    assemble_route,
    build_relation_query,
    build_search_query,
    clean_text,
    escape_ql_string,
    escape_regex,
    parse_bbox,
)
from tests.conftest import AuthHeaders, CreateUser

FIXTURES = Path(__file__).parent / "fixtures"
URL = "http://overpass.test/api/interpreter"
RELATION_ID = 4242


class FakeOverpass:
    """Stands in for the server, and records the queries it received."""

    def __init__(self) -> None:
        self.queries: list[str] = []
        self.requests: list[httpx.Request] = []
        self.response: httpx.Response | Exception = httpx.Response(200, json={"elements": []})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.queries.append(parse_qs(request.content.decode())["data"][0])
        if isinstance(self.response, Exception):
            raise self.response
        return self.response

    def answer(self, *elements: dict[str, Any]) -> None:
        self.response = httpx.Response(200, json={"elements": list(elements)})


@pytest.fixture
def overpass() -> Iterator[FakeOverpass]:
    fake = FakeOverpass()
    client = OverpassClient(URL, transport=httpx.MockTransport(fake))
    app.dependency_overrides[get_overpass_client] = lambda: client
    yield fake
    app.dependency_overrides.pop(get_overpass_client, None)


@pytest.fixture(autouse=True)
def no_dem(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """An empty DEM directory, unless a test puts tiles in it. Also keeps real tiles out."""
    directory = tmp_path / "dem"
    directory.mkdir()
    monkeypatch.setattr(get_settings(), "dem_dir", str(directory))
    return directory


def way_member(ref: int, *points: Coord, role: str = "") -> dict[str, Any]:
    return {
        "type": "way",
        "ref": ref,
        "role": role,
        "geometry": [{"lon": lon, "lat": lat} for lon, lat in points],
    }


def relation(
    relation_id: int = RELATION_ID,
    members: list[dict[str, Any]] | None = None,
    name: str | None = "Pot ob Savi",
) -> dict[str, Any]:
    tags = {"type": "route", "route": "hiking"}
    if name is not None:
        tags["name"] = name
    if members is None:
        members = [way_member(1, (13.01, 46.95), (13.02, 46.95), (13.03, 46.95))]
    return {"type": "relation", "id": relation_id, "tags": tags, "members": members}


def way(ref: int, *points: Coord, role: str = "") -> WayMember:
    return WayMember(ref, role, list(points))


# --- Escaping. The tokenizer below reads a query as Overpass does, to see what is a string.


def split_ql(query: str) -> tuple[str, list[str]]:
    """Returns the query with string contents removed, and the decoded strings."""
    outside: list[str] = []
    strings: list[str] = []
    position = 0
    escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "'": "'", "\\": "\\"}
    while position < len(query):
        char = query[position]
        if char != '"':
            outside.append(char)
            position += 1
            continue
        position += 1
        value: list[str] = []
        while True:
            assert position < len(query), "A string was left open"
            char = query[position]
            if char == '"':
                position += 1
                break
            if char == "\\":
                position += 1
                # Overpass keeps other backslash sequences as they are for the regex engine.
                following = query[position]
                value.append(escapes.get(following, "\\" + following))
            else:
                assert char not in "\n\r", "A raw line break inside a string"
                value.append(char)
            position += 1
        strings.append("".join(value))
        outside.append('""')
    return "".join(outside), strings


INJECTIONS = [
    '"];relation(1);out;//',
    '"]; node(1); out; ["name"="',
    '\\"];out;',
    '\\\\"];out;',
    "trailing\\",
    "trailing\\\\",
    '"',
    '""',
    "'];out;//",
    "/* comment */",
    "//",
    '~"x",i];(._;>;);out meta;',
    "[out:xml]",
    "{{bbox}}",
    "a\\u0022b",
    '"\\',
    '\\"',
]


@pytest.mark.parametrize("payload", INJECTIONS)
def test_search_text_cannot_break_out_of_the_query(payload: str) -> None:
    query = build_search_query(payload, None)

    outside, strings = split_ql(query)

    # The structure of the query is exactly as intended, whatever the text was.
    assert outside == ('[out:json][timeout:45];relation[""=""][""~"",i];out tags bb 50;')
    assert strings[:3] == ["route", "hiking", "name"]
    # And the text is a regular expression that matches itself, and is the only thing in there.
    assert len(strings) == 4
    assert re.fullmatch(strings[3], payload)


@pytest.mark.parametrize("payload", INJECTIONS)
def test_injection_attempts_stay_harmless_through_the_api(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    payload: str,
) -> None:
    response = client.get(
        "/api/trails/osm/search", headers=auth_headers(create_user()), params={"q": payload}
    )

    if len(clean_text(payload)) < 2:
        assert response.status_code == 422
        return
    assert response.status_code == 200
    outside, strings = split_ql(overpass.queries[-1])
    assert outside == '[out:json][timeout:45];relation[""=""][""~"",i];out tags bb 50;'
    assert len(strings) == 4


@pytest.mark.parametrize("payload", ['x"\n];out;', "x\r\n];out;", "x\x00y", "x\ty\x0b\x7fz"])
def test_control_characters_never_reach_the_query(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    payload: str,
) -> None:
    response = client.get(
        "/api/trails/osm/search", headers=auth_headers(create_user()), params={"q": payload}
    )

    assert response.status_code == 200
    assert not re.search(r"[\x00-\x1f\x7f]", overpass.queries[-1])
    outside, strings = split_ql(overpass.queries[-1])
    assert outside == '[out:json][timeout:45];relation[""=""][""~"",i];out tags bb 50;'
    assert len(strings) == 4


def test_regex_characters_match_literally() -> None:
    _, strings = split_ql(build_search_query("Sv. Ana (Krn)", None))
    pattern = strings[3]

    assert re.search(pattern, "Pot na Sv. Ana (Krn)")
    assert not re.search(pattern, "Sv, Ana (Krn)")
    assert not re.search(pattern, "Sv. Ana Krn")


def test_escape_helpers() -> None:
    assert escape_ql_string('a"b') == 'a\\"b'
    assert escape_ql_string("a\\b") == "a\\\\b"
    assert escape_regex("a.b*") == "a\\.b\\*"
    # Letters with diacritics and spaces stay as they are.
    assert escape_regex("Šmarna gora") == "Šmarna gora"


def test_clean_text() -> None:
    assert clean_text("  Krim \n\t pot \x00 ") == "Krim pot"
    assert clean_text("\x00\x01") == ""


# --- Bounding box


def test_parse_bbox() -> None:
    assert parse_bbox("13.3,45.4,16.6,46.9") == BoundingBox(13.3, 45.4, 16.6, 46.9)
    assert parse_bbox("-180,-90,180,90") == BoundingBox(-180, -90, 180, 90)


@pytest.mark.parametrize(
    "value",
    [
        "",
        "1,2,3",
        "1,2,3,4,5",
        "a,b,c,d",
        "13,45,14);out;//,46",
        '13,45,14,46"',
        "nan,45,14,46",
        "13,45,inf,46",
        "13,-91,14,46",
        "13,45,14,91",
        "-181,45,14,46",
        "13,45,181,46",
        # West of west, south of south
        "14,45,13,46",
        "13,46,14,45",
        "13,45,13,46",
    ],
)
def test_parse_bbox_rejects_invalid_values(value: str) -> None:
    with pytest.raises(ValueError):
        parse_bbox(value)


def test_bbox_goes_into_the_query_as_overpass_expects_it() -> None:
    query = build_search_query("krim", BoundingBox(west=13.5, south=45.5, east=14.5, north=46.5))

    assert "(45.5000000,13.5000000,46.5000000,14.5000000);" in query


def test_bbox_is_written_from_the_parsed_numbers_not_the_input() -> None:
    query = build_search_query("krim", parse_bbox("1e1, 45 ,1.1e1,46"))

    assert "(45.0000000,10.0000000,46.0000000,11.0000000);" in query
    assert "1e1" not in query


def test_relation_query_only_accepts_numbers() -> None:
    assert "relation(123)" in build_relation_query(123)
    with pytest.raises(ValueError):
        build_relation_query("1);out;//")  # type: ignore[arg-type]


# --- Assembling a line from a route's ways. Points on a line along 46 north, unless noted.


A, B, C, D, E = ((13.0 + step * 0.01, 46.0) for step in range(5))
BRANCH_END: Coord = (13.01, 46.05)


def test_ways_in_order() -> None:
    route = assemble_route([way(1, A, B), way(2, B, C)])

    assert route is not None
    assert route.coords == [A, B, C]
    assert route.complete


def test_ways_in_random_order_and_direction() -> None:
    route = assemble_route([way(3, D, C), way(1, A, B), way(4, D, E), way(2, C, B)])

    assert route is not None
    assert set(route.coords) == {A, B, C, D, E}
    assert route.coords in ([A, B, C, D, E], [E, D, C, B, A])
    assert route.distance_m == pytest.approx(line_length_m([A, E]), rel=1e-6)
    assert route.complete


def test_keeps_vertices_of_ways_when_reversing() -> None:
    bend: Coord = (13.005, 46.001)
    route = assemble_route([way(1, B, bend, A), way(2, B, C)])

    assert route is not None
    assert route.coords in ([A, bend, B, C], [C, B, bend, A])


def test_direction_follows_the_order_of_the_relation() -> None:
    # Every way is stored backwards, and the relation lists them from A to C.
    forward = assemble_route([way(1, B, A), way(2, C, B)])
    assert forward is not None
    assert forward.coords == [A, B, C]

    # The same ways listed the other way round describe the route from C to A.
    backward = assemble_route([way(2, C, B), way(1, B, A)])
    assert backward is not None
    assert backward.coords == [C, B, A]


def test_gap_keeps_the_longest_connected_part() -> None:
    # A-B then a gap, then C-D-E, the longer part.
    route = assemble_route([way(1, A, B), way(2, C, D), way(3, D, E)])

    assert route is not None
    assert route.coords == [C, D, E]
    assert route.distance_m == pytest.approx(line_length_m([C, E]), rel=1e-6)
    assert route.member_length_m == pytest.approx(
        line_length_m([A, B]) + line_length_m([C, E]), rel=1e-6
    )
    assert not route.complete


def test_branch_keeps_the_longest_chain() -> None:
    # A-B-C-D-E with a short side branch at B.
    side: Coord = (13.01, 46.001)
    route = assemble_route(
        [way(1, A, B), way(2, B, side), way(3, B, C), way(4, C, D), way(5, D, E)]
    )

    assert route is not None
    assert route.coords == [A, B, C, D, E]
    assert not route.complete


def test_longer_branch_wins_over_the_shorter_main_line() -> None:
    route = assemble_route([way(1, A, B), way(2, B, BRANCH_END), way(3, B, C)])

    assert route is not None
    assert route.coords == [A, B, BRANCH_END]


def test_section_that_splits_and_rejoins_is_walked_once() -> None:
    # S-A, then two ways from A to B, then B-E. Walking both would double the section.
    start: Coord = (12.99, 46.0)
    side_a: Coord = (13.005, 46.002)
    side_b: Coord = (13.005, 45.998)
    end: Coord = (13.02, 46.0)
    route = assemble_route(
        [way(1, start, A), way(2, A, side_a, B), way(3, A, side_b, B), way(4, B, end)]
    )

    assert route is not None
    assert route.coords[0] == start
    assert route.coords[-1] == end
    assert len(route.coords) == 5


def test_closed_loop_of_several_ways_is_kept_whole() -> None:
    north: Coord = (13.01, 46.01)
    east: Coord = (13.02, 46.0)
    route = assemble_route([way(1, A, north), way(2, north, east), way(3, east, A)])

    assert route is not None
    assert route.coords[0] == route.coords[-1]
    assert len(route.coords) == 4
    assert route.complete


def test_single_closed_way_is_kept_whole() -> None:
    north: Coord = (13.01, 46.01)
    east: Coord = (13.02, 46.0)
    route = assemble_route([way(1, A, north, east, A)])

    assert route is not None
    assert route.coords == [A, north, east, A]


def test_stem_with_a_loop_at_its_end_is_kept_whole() -> None:
    north: Coord = (13.02, 46.01)
    south: Coord = (13.02, 45.99)
    route = assemble_route([way(1, A, B), way(2, B, north), way(3, north, south), way(4, south, B)])

    assert route is not None
    assert route.coords[0] == A
    assert route.coords[-1] == B
    assert len(route.coords) == 5
    assert route.complete


def test_way_joining_another_in_the_middle_is_connected() -> None:
    # Way 2 ends at a point in the middle of way 1, not at its end. From E along way 1 and then
    # up the branch is the longest chain, which needs the connection at B.
    route = assemble_route([way(1, A, B, C, D, E), way(2, B, BRANCH_END)])

    assert route is not None
    assert route.coords == [E, D, C, B, BRANCH_END]
    assert not route.complete


def test_way_listed_twice_counts_once() -> None:
    route = assemble_route([way(1, A, B), way(2, B, C), way(2, C, B), way(1, B, A)])

    assert route is not None
    assert route.coords == [A, B, C]
    assert route.complete


def test_side_roles_are_left_out_of_the_route() -> None:
    far: Coord = (13.0, 46.5)
    route = assemble_route([way(1, A, B), way(2, B, far, role="excursion"), way(3, B, C)])

    assert route is not None
    assert route.coords == [A, B, C]
    assert route.complete


def test_route_of_only_side_roles_is_still_used() -> None:
    route = assemble_route([way(1, A, B, role="alternative")])

    assert route is not None
    assert route.coords == [A, B]


def test_repeated_points_are_dropped() -> None:
    route = assemble_route([way(1, A, A, B, B)])

    assert route is not None
    assert route.coords == [A, B]


@pytest.mark.parametrize("ways", [[], [way(1)], [way(1, A)], [way(1, A, A)]])
def test_no_usable_line(ways: list[WayMember]) -> None:
    assert assemble_route(ways) is None


def test_route_with_many_ways_is_fast_and_complete() -> None:
    points = [(13.0 + step * 0.0001, 46.0) for step in range(5001)]
    ways = [way(step, points[step + 1], points[step]) for step in range(5000)]
    ways.reverse()

    route = assemble_route(ways)

    assert route is not None
    assert len(route.coords) == 5001
    assert route.complete


def test_tangled_web_of_ways_gives_an_answer_within_the_search_limit() -> None:
    # A grid has an astronomical number of paths, so this only ends thanks to the search limit.
    size = 12

    def point(x: int, y: int) -> Coord:
        return (13 + x / 100, 46 + y / 100)

    ways: list[WayMember] = []
    for x in range(size):
        for y in range(size):
            for right, up in ((1, 0), (0, 1)):
                if x + right < size and y + up < size:
                    ways.append(way(len(ways), point(x, y), point(x + right, y + up)))

    route = assemble_route(ways)

    assert route is not None
    # Much of the grid is in the chain, and each junction at most once.
    assert route.distance_m > 10 * line_length_m([point(0, 0), point(1, 0)])
    assert len(route.coords) - 1 == len(set(route.coords[:-1]))
    assert not route.complete


def test_real_route_with_ways_out_of_sequence() -> None:
    """Aljažev dom - Kredarica - Triglav, as Overpass returned it. OSM data © OpenStreetMap
    contributors, ODbL. Its ways do not simply follow each other end to end."""
    payload = json.loads((FIXTURES / "overpass_relation_19446684.json").read_text())
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=payload))

    parsed = OverpassClient(URL, transport=transport).relation(19446684)

    assert parsed is not None
    assert parsed.name == "Aljažev dom - Kredarica - Triglav"
    assert len(parsed.ways) == 9
    route = assemble_route(parsed.ways)
    assert route is not None
    # From the valley (north) to the summit (south), as the relation lists it.
    assert route.coords[0][1] == pytest.approx(46.4093, abs=0.001)
    assert route.coords[-1][1] == pytest.approx(46.3783, abs=0.001)
    assert route.distance_m == pytest.approx(5792, abs=5)
    assert route.complete
    # Consecutive points of the line are close together: nothing jumps across a gap.
    steps = [
        line_length_m([first, second])
        for first, second in zip(route.coords, route.coords[1:], strict=False)
    ]
    assert max(steps) < 500


def test_distance_agrees_with_postgis_geography(session: Session) -> None:
    coords = [(13.84, 46.41), (13.85, 46.38), (13.9, 46.3), (14.2, 46.1)]
    line = "LINESTRING(" + ",".join(f"{lon} {lat}" for lon, lat in coords) + ")"

    postgis = session.scalar(
        text("SELECT ST_Length(ST_GeogFromText(:line))"), {"line": f"SRID=4326;{line}"}
    )

    assert line_length_m(coords) == pytest.approx(postgis, abs=0.5)


# --- Search endpoint


SEARCH_HIT = {
    "type": "relation",
    "id": 19446684,
    "bounds": {"minlat": 46.3, "minlon": 13.8, "maxlat": 46.4, "maxlon": 13.9},
    "tags": {
        "name": "Aljažev dom - Triglav",
        "route": "hiking",
        "network": "lwn",
        "ref": "1",
        "from": "Aljažev dom",
        "to": "Triglav",
    },
}


def test_search_returns_routes_sorted_by_name(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(
        {"type": "relation", "id": 2, "tags": {"name": "Zadnja"}},
        SEARCH_HIT,
        {"type": "relation", "id": 3, "tags": {"name": "bled"}},
    )

    response = client.get(
        "/api/trails/osm/search", headers=auth_headers(create_user()), params={"q": "Triglav"}
    )

    assert response.status_code == 200
    body = response.json()
    assert [item["name"] for item in body["items"]] == ["Aljažev dom - Triglav", "bled", "Zadnja"]
    assert body["total"] == 3
    assert body["items"][0] == {
        "relation_id": 19446684,
        "name": "Aljažev dom - Triglav",
        "ref": "1",
        "network": "lwn",
        "start_name": "Aljažev dom",
        "end_name": "Triglav",
        "bbox": [13.8, 46.3, 13.9, 46.4],
    }
    assert 'relation["route"="hiking"]["name"~"Triglav",i];' in overpass.queries[0]


def test_search_sends_a_descriptive_user_agent(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    client.get(
        "/api/trails/osm/search", headers=auth_headers(create_user()), params={"q": "Triglav"}
    )

    assert overpass.requests[0].headers["user-agent"] == USER_AGENT
    assert "TrailStat" in USER_AGENT
    assert str(overpass.requests[0].url) == URL


def test_search_within_a_bounding_box(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    client.get(
        "/api/trails/osm/search",
        headers=auth_headers(create_user()),
        params={"q": "Krim", "bbox": "14.1,45.8,14.9,46.2"},
    )

    assert "(45.8000000,14.1000000,46.2000000,14.9000000);" in overpass.queries[0]


def test_search_without_results(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    body = client.get(
        "/api/trails/osm/search", headers=auth_headers(create_user()), params={"q": "Nothing"}
    ).json()

    assert (body["items"], body["total"]) == ([], 0)


def test_relation_without_a_name_uses_ref_or_stays_unnamed(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(
        {"type": "relation", "id": 1, "tags": {"ref": "GR5"}},
        {"type": "relation", "id": 2, "tags": {}},
        {"type": "relation", "id": 3},
    )

    body = client.get(
        "/api/trails/osm/search", headers=auth_headers(create_user()), params={"q": "Krim"}
    ).json()

    assert sorted(str(item["name"]) for item in body["items"]) == ["GR5", "None", "None"]


@pytest.mark.parametrize("q", ["", " ", "x", " x ", "\x00", "x\x00"])
def test_search_text_must_have_two_characters_and_does_not_reach_overpass(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    q: str,
) -> None:
    response = client.get(
        "/api/trails/osm/search", headers=auth_headers(create_user()), params={"q": q}
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "osm_search_too_short"
    assert overpass.queries == []


def test_search_text_length_and_presence_are_checked(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    headers = auth_headers(create_user())

    assert client.get("/api/trails/osm/search", headers=headers).status_code == 422
    response = client.get("/api/trails/osm/search", headers=headers, params={"q": "x" * 101})
    assert response.status_code == 422
    assert overpass.queries == []


@pytest.mark.parametrize(
    "bbox", ["1,2,3", "a,b,c,d", "13,45,14);out;//,46", "nan,1,2,3", "14,45,13,46"]
)
def test_invalid_bbox_is_rejected_and_does_not_reach_overpass(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    bbox: str,
) -> None:
    response = client.get(
        "/api/trails/osm/search",
        headers=auth_headers(create_user()),
        params={"q": "Krim", "bbox": bbox},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "invalid_bbox"
    assert overpass.queries == []


def test_osm_endpoints_require_sign_in(client: TestClient, overpass: FakeOverpass) -> None:
    assert client.get("/api/trails/osm/search", params={"q": "Krim"}).status_code == 401
    assert client.get(f"/api/trails/osm/{RELATION_ID}").status_code == 401
    assert (
        client.post(
            "/api/trails/osm/import", json={"relation_id": RELATION_ID, "visibility": "private"}
        ).status_code
        == 401
    )
    assert overpass.queries == []


# --- Upstream failures


FAILURES: list[httpx.Response | Exception] = [
    httpx.Response(429, text="Too many requests"),
    httpx.Response(429, json={"elements": []}),
    httpx.Response(504, json={"elements": []}),
    httpx.Response(504, text="Gateway timeout"),
    httpx.Response(500, text="Internal error"),
    httpx.Response(400, text="Bad query"),
    httpx.Response(200, text="<html>The server is busy</html>"),
    httpx.Response(200, json=["not", "an", "object"]),
    httpx.Response(200, json={"no": "elements"}),
    httpx.Response(200, json={"elements": "not a list"}),
    httpx.Response(
        200, json={"elements": [], "remark": 'runtime error: Query timed out in "query"'}
    ),
    httpx.Response(200, json={"elements": [], "remark": "runtime error: out of memory"}),
    httpx.Response(200, json={"elements": [{"type": "relation"}]}),
    httpx.Response(200, json={"elements": [{"id": "x"}]}),
    httpx.ConnectError("refused"),
    httpx.ReadTimeout("too slow"),
    httpx.ConnectTimeout("too slow"),
]


@pytest.mark.parametrize("failure", FAILURES)
def test_search_failures_become_osm_unavailable(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    failure: httpx.Response | Exception,
) -> None:
    overpass.response = failure

    response = client.get(
        "/api/trails/osm/search", headers=auth_headers(create_user()), params={"q": "Krim"}
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "osm_unavailable"


@pytest.mark.parametrize("failure", FAILURES)
def test_preview_and_import_failures_become_osm_unavailable(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    failure: httpx.Response | Exception,
) -> None:
    overpass.response = failure
    headers = auth_headers(create_user())

    preview = client.get(f"/api/trails/osm/{RELATION_ID}", headers=headers)
    imported = client.post(
        "/api/trails/osm/import",
        headers=headers,
        json={"relation_id": RELATION_ID, "visibility": "private"},
    )

    assert (preview.status_code, preview.json()["detail"]) == (503, "osm_unavailable")
    assert (imported.status_code, imported.json()["detail"]) == (503, "osm_unavailable")
    assert session.scalar(select(func.count()).select_from(Trail)) == 0


def test_a_harmless_remark_is_not_a_failure(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.response = httpx.Response(200, json={"elements": [], "remark": "All good"})

    response = client.get(
        "/api/trails/osm/search", headers=auth_headers(create_user()), params={"q": "Krim"}
    )

    assert response.status_code == 200


# --- Preview endpoint


def test_preview_returns_geometry_and_geodesic_distance(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation())

    response = client.get(f"/api/trails/osm/{RELATION_ID}", headers=auth_headers(create_user()))

    assert response.status_code == 200
    body = response.json()
    assert body["relation_id"] == RELATION_ID
    assert body["name"] == "Pot ob Savi"
    assert body["geometry"] == {
        "type": "LineString",
        "coordinates": [[13.01, 46.95], [13.02, 46.95], [13.03, 46.95]],
    }
    # Two hundredths of a degree of longitude at 46.95 north, not 2226 m as at the equator.
    assert body["distance_m"] == pytest.approx(1523, abs=1)
    assert body["complete"] is True
    assert f"relation({RELATION_ID})" in overpass.queries[0]
    assert '["route"="hiking"]' in overpass.queries[0]
    assert "out geom" in overpass.queries[0]


def test_preview_says_when_part_of_the_route_is_left_out(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation(members=[way_member(1, A, B), way_member(2, C, D, E)]))

    body = client.get(f"/api/trails/osm/{RELATION_ID}", headers=auth_headers(create_user())).json()

    assert body["complete"] is False
    assert body["member_length_m"] > body["distance_m"]


@pytest.mark.parametrize("relation_id", ["0", "-1", "abc", "1;out", "1.5", str(10**15 + 1)])
def test_preview_only_accepts_a_positive_number_as_id(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    relation_id: str,
) -> None:
    response = client.get(f"/api/trails/osm/{relation_id}", headers=auth_headers(create_user()))

    assert response.status_code == 422
    assert overpass.queries == []


def test_preview_of_unknown_or_non_hiking_relation_is_not_found(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    response = client.get(f"/api/trails/osm/{RELATION_ID}", headers=auth_headers(create_user()))

    assert response.status_code == 404
    assert response.json()["detail"] == "osm_route_not_found"


@pytest.mark.parametrize(
    "members",
    [
        [],
        # A route of routes: the nested relations come without geometry.
        [{"type": "relation", "ref": 5, "role": ""}],
        [{"type": "node", "ref": 5, "role": "guidepost", "lat": 46.0, "lon": 13.0}],
        [{"type": "way", "ref": 5, "role": ""}],
        [{"type": "way", "ref": 5, "role": "", "geometry": [None, None]}],
        [{"type": "way", "ref": 5, "role": "", "geometry": [{"lat": 46.0, "lon": 13.0}]}],
    ],
)
def test_route_without_geometry_is_reported(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    members: list[dict[str, Any]],
) -> None:
    overpass.answer(relation(members=members))

    response = client.get(f"/api/trails/osm/{RELATION_ID}", headers=auth_headers(create_user()))

    assert response.status_code == 422
    assert response.json()["detail"] == "osm_route_without_geometry"


# --- Import endpoint


MakeTile = Callable[[Path], None]


def write_slope_tile(directory: Path) -> None:
    """Climbs 2000 m per degree of longitude, over 13 to 13.1 east and 46.9 to 47 north."""
    pixel = 1 / 3600
    size = 360
    west = 13 - pixel / 2
    north = 47 + pixel / 2
    columns = np.tile(np.arange(size), (size, 1))
    data = (1000 + (west + (columns + 0.5) * pixel - 13) * 2000).astype("float32")
    with rasterio.open(
        directory / "tile.tif",
        "w",
        driver="GTiff",
        width=size,
        height=size,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(west, north, pixel, pixel),
    ) as dataset:
        dataset.write(data, 1)


def test_import_stores_the_route_with_elevation(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    no_dem: Path,
) -> None:
    write_slope_tile(no_dem)
    overpass.answer(relation())
    user = create_user(display_name="Marko")

    response = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(user),
        json={"relation_id": RELATION_ID, "visibility": "private"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "Pot ob Savi"
    assert body["source"] == "osm"
    assert body["osm_relation_id"] == RELATION_ID
    assert body["owner_user_id"] == str(user.id)
    assert body["owner_name"] == "Marko"
    assert body["visibility"] == "private"
    assert body["geometry"]["type"] == "LineString"
    assert body["geometry"]["coordinates"][0] == [13.01, 46.95]
    # 13.01 to 13.03 east climbs 40 m.
    assert body["elevation_gain_m"] == 40
    assert body["elevation_loss_m"] == 0
    assert body["highest_point_m"] == 1060
    assert body["elevation_profile"][0] == [0, pytest.approx(1020, abs=0.1)]
    assert body["elevation_profile"][-1][0] == body["distance_m"]

    # The stored length, measured independently by PostGIS on the stored geometry
    stored = session.scalar(
        select(func.ST_Length(func.Geography(Trail.geometry))).where(Trail.id == body["id"])
    )
    assert stored == pytest.approx(body["distance_m"], abs=1)

    # And it reads back the same
    again = client.get(f"/api/trails/{body['id']}", headers=auth_headers(user)).json()
    assert again["geometry"] == body["geometry"]
    assert again["elevation_profile"] == body["elevation_profile"]


def test_import_outside_elevation_coverage_succeeds_with_null_elevation(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation())

    response = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(create_user()),
        json={"relation_id": RELATION_ID, "visibility": "private"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["elevation_gain_m"] is None
    assert body["elevation_loss_m"] is None
    assert body["highest_point_m"] is None
    assert body["elevation_profile"] is None
    assert body["geometry"] is not None
    assert body["distance_m"] > 0


def test_import_with_own_name(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation())

    body = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(create_user()),
        json={"relation_id": RELATION_ID, "name": "  Moja pot ", "visibility": "public"},
    ).json()

    assert body["name"] == "Moja pot"
    assert body["visibility"] == "public"


def test_import_shortens_an_overlong_osm_name(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation(name="x" * 300))

    body = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(create_user()),
        json={"relation_id": RELATION_ID, "visibility": "private"},
    ).json()

    assert body["name"] == "x" * 200


def test_import_cleans_control_characters_from_an_osm_name(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation(name="  Pot\nob\x00 Savi "))

    body = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(create_user()),
        json={"relation_id": RELATION_ID, "visibility": "private"},
    ).json()

    assert body["name"] == "Pot ob Savi"


def test_import_requires_a_name_when_osm_has_none(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation(name=None))
    headers = auth_headers(create_user())

    response = client.post(
        "/api/trails/osm/import",
        headers=headers,
        json={"relation_id": RELATION_ID, "visibility": "private"},
    )
    assert (response.status_code, response.json()["detail"]) == (422, "name_required")

    overpass.answer(relation(name=None))
    named = client.post(
        "/api/trails/osm/import",
        headers=headers,
        json={"relation_id": RELATION_ID, "name": "Moja", "visibility": "private"},
    )
    assert named.status_code == 201


@pytest.mark.parametrize(
    "fields",
    [
        {"relation_id": 0},
        {"relation_id": -1},
        {"relation_id": "1);out;//"},
        {"relation_id": 1.5},
        {"relation_id": 10**15 + 1},
        {"name": "   "},
        {"name": "x" * 201},
        {"name": "nul\x00"},
        {"visibility": "secret"},
        {"group_id": "not-a-uuid"},
    ],
)
def test_import_rejects_invalid_input_before_contacting_overpass(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    fields: dict[str, Any],
) -> None:
    response = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(create_user()),
        json={"relation_id": RELATION_ID, "visibility": "private", **fields},
    )

    assert response.status_code == 422
    assert overpass.queries == []


def test_import_of_a_taken_name_conflicts(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation())
    headers = auth_headers(create_user())
    body = {"relation_id": RELATION_ID, "visibility": "private"}
    assert client.post("/api/trails/osm/import", headers=headers, json=body).status_code == 201

    overpass.answer(relation())
    response = client.post("/api/trails/osm/import", headers=headers, json=body)

    assert (response.status_code, response.json()["detail"]) == (409, "trail_name_taken")


def _group(session: Session, *members: tuple[User, GroupRole]) -> Group:
    group = Group(name="Planinci", visibility=GroupVisibility.PRIVATE)
    session.add(group)
    session.flush()
    for user, role in members:
        session.add(GroupMembership(group_id=group.id, user_id=user.id, role=role))
    session.commit()
    return group


def test_import_shared_with_own_group(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
) -> None:
    overpass.answer(relation())
    member = create_user()
    group = _group(session, (member, GroupRole.MEMBER))

    body = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(member),
        json={"relation_id": RELATION_ID, "visibility": "group", "group_id": str(group.id)},
    ).json()

    assert (body["visibility"], body["group_id"]) == ("group", str(group.id))


def test_import_to_a_foreign_group_is_refused_before_contacting_overpass(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
) -> None:
    group = _group(session, (create_user(), GroupRole.MEMBER))

    response = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(create_user()),
        json={"relation_id": RELATION_ID, "visibility": "group", "group_id": str(group.id)},
    )

    assert response.status_code == 404
    assert overpass.queries == []


@pytest.mark.parametrize(
    ("visibility", "with_group", "code"),
    [("group", False, "group_required"), ("private", True, "group_not_allowed")],
)
def test_import_checks_the_group_matches_the_visibility(
    client: TestClient,
    session: Session,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    overpass: FakeOverpass,
    visibility: str,
    with_group: bool,
    code: str,
) -> None:
    member = create_user()
    group = _group(session, (member, GroupRole.MEMBER))

    response = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(member),
        json={
            "relation_id": RELATION_ID,
            "visibility": visibility,
            "group_id": str(group.id) if with_group else None,
        },
    )

    assert (response.status_code, response.json()["detail"]) == (422, code)
    assert overpass.queries == []


def test_imported_private_trail_is_hidden_from_others(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation())
    body = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(create_user()),
        json={"relation_id": RELATION_ID, "visibility": "private"},
    ).json()

    response = client.get(f"/api/trails/{body['id']}", headers=auth_headers(create_user()))

    assert response.status_code == 404


def test_measurements_of_an_imported_trail_cannot_be_edited(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, overpass: FakeOverpass
) -> None:
    overpass.answer(relation())
    owner = create_user()
    body = client.post(
        "/api/trails/osm/import",
        headers=auth_headers(owner),
        json={"relation_id": RELATION_ID, "visibility": "private"},
    ).json()
    url = f"/api/trails/{body['id']}"

    for field, value in (("distance_m", 1), ("elevation_gain_m", 1), ("highest_point_m", 1)):
        response = client.patch(url, headers=auth_headers(owner), json={field: value})
        assert (response.status_code, response.json()["detail"]) == (
            422,
            "osm_measurements_read_only",
        )

    renamed = client.patch(
        url, headers=auth_headers(owner), json={"name": "New", "description": "Lepa"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["distance_m"] == body["distance_m"]
    assert renamed.json()["source"] == "osm"
