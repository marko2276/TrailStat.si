"""Trails with a loaded route, for example from a GPX or KML file read in the browser."""

from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import ElevationSource, Group, GroupGuest, GroupVisibility, Trail, TrailSource
from app.services import route as route_service
from app.services.geo import line_length_m
from app.services.route import RouteTooShort, prepare_route, simplify
from tests.conftest import AuthHeaders, CreateUser
from tests.test_trails import hike_on
from tests.test_trails_elevation import LATITUDE, SMALL, east_slope, write_tile

# About 111 m between points, going east inside the small DEM tile.
STEP = 0.001
METRES_PER_DEGREE_LATITUDE = 111_195


@pytest.fixture(autouse=True)
def dem(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """An empty DEM directory, unless a test puts tiles in it. Also keeps real tiles out."""
    directory = tmp_path / "dem"
    directory.mkdir()
    monkeypatch.setattr(get_settings(), "dem_dir", str(directory))
    return directory


def eastward(count: int, west: float = 13.01, latitude: float = LATITUDE) -> list[list[float]]:
    return [[west + i * STEP, latitude] for i in range(count)]


def line(points: list[list[float]]) -> dict[str, Any]:
    return {"type": "LineString", "coordinates": points}


def manual_trail(client: TestClient, headers: dict[str, str], **fields: Any) -> dict[str, Any]:
    body = {
        "name": "Šmarna gora",
        "distance_m": 4200,
        "elevation_gain_m": 350,
        "visibility": "private",
        **fields,
    }
    response = client.post("/api/trails", headers=headers, json=body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


# Simplifying


def test_points_along_a_straight_line_are_dropped() -> None:
    x = np.arange(100, dtype=np.float64)
    y = np.zeros(100)

    assert simplify(x, y, 3.0).tolist() == [0, 99]


def test_jitter_below_the_tolerance_is_dropped_and_a_real_bend_kept() -> None:
    x = np.arange(0, 200, dtype=np.float64)
    # An L-shape: east for 100 m, then north, with a metre of jitter all along.
    y = np.where(x < 100, 0.0, x - 100) + np.sin(x) * 1.0
    x = np.where(x < 100, x, 100.0)

    kept = simplify(x, y, 3.0).tolist()

    assert kept[0] == 0 and kept[-1] == 199
    assert any(95 <= index <= 105 for index in kept)
    assert len(kept) < 10


def test_a_loop_back_to_the_start_keeps_its_shape() -> None:
    angles = np.linspace(0, 2 * np.pi, 400)
    x, y = np.cos(angles) * 500, np.sin(angles) * 500

    kept = simplify(x, y, 3.0)

    assert 10 < len(kept) < 400


def test_a_long_noisy_recording_is_kept_below_the_stored_maximum(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(route_service, "MAX_STORED_POINTS", 50)
    rng = np.random.default_rng(1)
    points = [
        [13.01 + i * 0.00002 + rng.normal(0, 0.0001), LATITUDE + rng.normal(0, 0.0001)]
        for i in range(5000)
    ]

    route = prepare_route(points, "/nonexistent")

    assert len(route.coords) <= 50


# Measuring


def test_distance_is_measured_on_the_ellipsoid() -> None:
    points = [[14.5, 46.0], [14.5, 46.01]]

    route = prepare_route(points, "/nonexistent")

    assert route.distance_m == pytest.approx(METRES_PER_DEGREE_LATITUDE * 0.01, rel=0.005)


def test_repeated_positions_are_one_point() -> None:
    points = [[14.5, 46.0], [14.5, 46.0], [14.5, 46.0], [14.5, 46.01]]

    assert len(prepare_route(points, "/nonexistent").coords) == 2


def test_a_route_that_never_moves_is_too_short() -> None:
    with pytest.raises(RouteTooShort):
        prepare_route([[14.5, 46.0], [14.5, 46.0]], "/nonexistent")


def test_elevation_comes_from_the_dem_where_it_covers_the_route(dem: Path) -> None:
    write_tile(dem / "a.tif", 13, 47, east_slope(2000), SMALL)
    # Heights in the route say otherwise: the DEM wins, so all trails are measured alike.
    points = [[*point, 0.0] for point in eastward(50)]

    route = prepare_route(points, dem)

    assert route.elevation_source == ElevationSource.DEM
    assert route.elevation is not None
    assert route.elevation.gain_m == pytest.approx(49 * STEP * 2000, abs=2)


def test_outside_the_dem_the_routes_own_heights_are_used() -> None:
    # Climbing 2 m every 111 m, then the same back down, on a bend so the points are kept.
    up = [[13.01 + i * STEP, LATITUDE + i * i * 1e-6, 500.0 + 2 * i] for i in range(50)]
    down = [[point[0], point[1] + 0.01, 500.0 + 2 * (49 - i)] for i, point in enumerate(up)]

    route = prepare_route(up + down, "/nonexistent")

    assert route.elevation_source == ElevationSource.FILE
    assert route.elevation is not None
    assert route.elevation.highest_m == 598
    assert route.elevation.gain_m == pytest.approx(98, abs=3)
    assert route.elevation.loss_m == pytest.approx(98, abs=3)


def test_without_dem_and_with_a_height_missing_there_is_no_elevation() -> None:
    points: list[list[float]] = [[*point, 500.0] for point in eastward(10)]
    points[5] = points[5][:2]
    # A bend at the point without height, so it is kept.
    points[5][1] += 0.001

    route = prepare_route(points, "/nonexistent")

    assert route.elevation is None
    assert route.elevation_source is None


def test_implausible_heights_are_not_used() -> None:
    points = [[*point, 99_999.0] for point in eastward(10)]

    assert prepare_route(points, "/nonexistent").elevation is None


# Previewing


def test_preview_measures_the_route_without_saving_it(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, session: Session
) -> None:
    user = create_user()
    points = eastward(20)

    response = client.post(
        "/api/trails/route-preview", headers=auth_headers(user), json={"geometry": line(points)}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    # A straight line needs only its ends.
    assert body["geometry"]["coordinates"] == [points[0], points[-1]]
    assert body["distance_m"] == round(line_length_m([(p[0], p[1]) for p in points]))
    assert body["elevation_gain_m"] is None
    assert body["elevation_source"] is None
    assert session.scalar(select(func.count()).select_from(Trail)) == 0


def test_preview_with_dem_gives_profile_and_source(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, dem: Path
) -> None:
    write_tile(dem / "a.tif", 13, 47, east_slope(2000), SMALL)

    response = client.post(
        "/api/trails/route-preview",
        headers=auth_headers(create_user()),
        json={"geometry": line(eastward(30))},
    )

    body = response.json()
    assert body["elevation_source"] == "dem"
    assert body["elevation_gain_m"] > 0
    assert len(body["elevation_profile"]) >= 2


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "LineString", "coordinates": [[14.5, 46.0]]},
        {"type": "LineString", "coordinates": [[14.5, 91.0], [14.5, 46.0]]},
        {"type": "LineString", "coordinates": [[181.0, 46.0], [14.5, 46.0]]},
        {"type": "LineString", "coordinates": [[14.5, 46.0, 1, 2], [14.5, 46.1]]},
        {"type": "Point", "coordinates": [[14.5, 46.0], [14.5, 46.1]]},
        {"type": "LineString", "coordinates": [["a", 46.0], [14.5, 46.1]]},
    ],
)
def test_preview_refuses_what_is_not_a_route(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    geometry: dict[str, Any],
) -> None:
    response = client.post(
        "/api/trails/route-preview",
        headers=auth_headers(create_user()),
        json={"geometry": geometry},
    )

    assert response.status_code == 422


def test_preview_refuses_non_finite_numbers(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    raw = '{"geometry": {"type": "LineString", "coordinates": [[14.5, 46.0, NaN], [14.5, 46.1]]}}'

    response = client.post(
        "/api/trails/route-preview",
        headers={**auth_headers(create_user()), "Content-Type": "application/json"},
        content=raw,
    )

    assert response.status_code == 422
    # Not echoed: JSON cannot carry it.
    assert "NaN" not in response.text and "nan" not in response.text


def test_preview_of_a_route_that_never_moves(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    response = client.post(
        "/api/trails/route-preview",
        headers=auth_headers(create_user()),
        json={"geometry": line([[14.5, 46.0], [14.5, 46.0]])},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "route_too_short"


def test_preview_needs_an_account(client: TestClient) -> None:
    response = client.post("/api/trails/route-preview", json={"geometry": line(eastward(3))})

    assert response.status_code == 401


def test_previews_and_saves_are_rate_limited_together(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(create_user())
    body = {"geometry": line(eastward(3))}
    for _ in range(29):
        assert (
            client.post("/api/trails/route-preview", headers=headers, json=body).status_code == 200
        )
    assert manual_trail(client, headers, distance_m=None, elevation_gain_m=None, **body)

    response = client.post("/api/trails/route-preview", headers=headers, json=body)

    assert response.status_code == 429


# Creating


def test_create_with_a_route_takes_measurements_from_it(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, dem: Path
) -> None:
    write_tile(dem / "a.tif", 13, 47, east_slope(2000), SMALL)
    points = eastward(30)

    response = client.post(
        "/api/trails",
        headers=auth_headers(create_user()),
        json={"name": "Z datoteke", "visibility": "private", "geometry": line(points)},
    )

    assert response.status_code == 201, response.text
    trail = response.json()
    assert trail["source"] == "file"
    assert trail["geometry"]["coordinates"] == [points[0], points[-1]]
    # 29 steps of about 76 m: degrees of longitude are short at 47 degrees north.
    assert trail["distance_m"] == pytest.approx(29 * 76, rel=0.01)
    assert trail["elevation_gain_m"] > 0
    assert trail["elevation_source"] == "dem"
    assert trail["elevation_profile"]
    assert trail["can_edit_measurements"] is False
    assert trail["can_replace_route"] is True


def test_route_heights_are_not_stored(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, session: Session
) -> None:
    points = [[*point, 700.0] for point in eastward(5)]

    response = client.post(
        "/api/trails",
        headers=auth_headers(create_user()),
        json={"name": "Ravnina", "visibility": "private", "geometry": line(points)},
    )

    trail = response.json()
    assert trail["elevation_source"] == "file"
    assert all(len(point) == 2 for point in trail["geometry"]["coordinates"])
    dimensions = session.scalar(select(func.ST_NDims(Trail.geometry)))
    assert dimensions == 2


def test_measurements_and_a_route_together_are_refused(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    response = client.post(
        "/api/trails",
        headers=auth_headers(create_user()),
        json={
            "name": "Oboje",
            "visibility": "private",
            "distance_m": 1000,
            "geometry": line(eastward(3)),
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "measurements_from_route"


@pytest.mark.parametrize("missing", ["distance_m", "elevation_gain_m"])
def test_without_a_route_the_measurements_are_still_required(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders, missing: str
) -> None:
    body = {"name": "Ročno", "visibility": "private", "distance_m": 1000, "elevation_gain_m": 10}
    del body[missing]

    response = client.post("/api/trails", headers=auth_headers(create_user()), json=body)

    assert response.status_code == 422
    assert response.json()["detail"] == f"{missing}_required"


# Loading a route into an existing trail


def test_loading_a_route_into_a_manual_trail(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(create_user())
    trail = manual_trail(client, headers, highest_point_m=669)
    assert trail["can_replace_route"] is True

    response = client.patch(
        f"/api/trails/{trail['id']}", headers=headers, json={"geometry": line(eastward(10))}
    )

    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["source"] == "file"
    assert updated["geometry"] is not None
    assert updated["distance_m"] != 4200
    # Outside the elevation data and without heights: the typed-in figures no longer fit.
    assert updated["elevation_gain_m"] is None
    assert updated["highest_point_m"] is None
    assert updated["name"] == "Šmarna gora"


def test_a_file_trails_route_can_be_replaced(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(create_user())
    trail = manual_trail(client, headers)
    client.patch(
        f"/api/trails/{trail['id']}", headers=headers, json={"geometry": line(eastward(10))}
    )

    response = client.patch(
        f"/api/trails/{trail['id']}", headers=headers, json={"geometry": line(eastward(20))}
    )

    assert response.status_code == 200
    assert response.json()["distance_m"] == pytest.approx(19 * 76, rel=0.01)


def test_a_file_trails_measurements_cannot_be_typed_in(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(create_user())
    trail = manual_trail(client, headers)
    client.patch(
        f"/api/trails/{trail['id']}", headers=headers, json={"geometry": line(eastward(10))}
    )

    response = client.patch(f"/api/trails/{trail['id']}", headers=headers, json={"distance_m": 5})

    assert response.status_code == 422
    assert response.json()["detail"] == "route_measurements_read_only"


def test_a_route_and_measurements_in_one_update_are_refused(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(create_user())
    trail = manual_trail(client, headers)

    response = client.patch(
        f"/api/trails/{trail['id']}",
        headers=headers,
        json={"geometry": line(eastward(10)), "elevation_gain_m": 5},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "measurements_from_route"


def test_a_route_cannot_be_removed(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    headers = auth_headers(create_user())
    trail = manual_trail(client, headers)

    response = client.patch(f"/api/trails/{trail['id']}", headers=headers, json={"geometry": None})

    assert response.status_code == 422
    assert response.json()["detail"] == "route_required"


def test_an_osm_trails_route_cannot_be_replaced(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    session: Session,
) -> None:
    user = create_user()
    trail = manual_trail(client, auth_headers(user))
    row = session.get(Trail, trail["id"])
    assert row is not None
    row.source = TrailSource.OSM
    session.commit()

    detail = client.get(f"/api/trails/{trail['id']}", headers=auth_headers(user)).json()
    response = client.patch(
        f"/api/trails/{trail['id']}",
        headers=auth_headers(user),
        json={"geometry": line(eastward(10))},
    )

    assert detail["can_replace_route"] is False
    assert response.status_code == 422
    assert response.json()["detail"] == "osm_route_read_only"


def test_the_route_is_locked_once_someone_else_attended(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    session: Session,
) -> None:
    owner, friend = create_user(), create_user()
    trail = manual_trail(client, auth_headers(owner), visibility="public")
    hike_on(session, trail["id"], users=(owner, friend))

    detail = client.get(f"/api/trails/{trail['id']}", headers=auth_headers(owner)).json()
    response = client.patch(
        f"/api/trails/{trail['id']}",
        headers=auth_headers(owner),
        json={"geometry": line(eastward(10))},
    )

    assert detail["can_replace_route"] is False
    assert response.status_code == 409
    assert response.json()["detail"] == "trail_measurements_in_use"


def test_a_guest_on_a_hike_also_locks_the_route(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    session: Session,
) -> None:
    owner = create_user()
    trail = manual_trail(client, auth_headers(owner))
    group = Group(name="Hikers", visibility=GroupVisibility.PRIVATE)
    session.add(group)
    session.flush()
    guest = GroupGuest(group_id=group.id, nickname="Ana")
    session.add(guest)
    session.commit()
    hike_on(session, trail["id"], users=(owner,), guests=(guest,), group=group)

    response = client.patch(
        f"/api/trails/{trail['id']}",
        headers=auth_headers(owner),
        json={"geometry": line(eastward(10))},
    )

    assert response.status_code == 409


def test_own_hikes_do_not_lock_the_route(
    client: TestClient,
    create_user: CreateUser,
    auth_headers: AuthHeaders,
    session: Session,
) -> None:
    owner = create_user()
    trail = manual_trail(client, auth_headers(owner))
    hike_on(session, trail["id"], users=(owner,))

    response = client.patch(
        f"/api/trails/{trail['id']}",
        headers=auth_headers(owner),
        json={"geometry": line(eastward(10))},
    )

    assert response.status_code == 200


def test_someone_who_cannot_edit_cannot_load_a_route(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    owner, other = create_user(), create_user()
    trail = manual_trail(client, auth_headers(owner), visibility="public")

    detail = client.get(f"/api/trails/{trail['id']}", headers=auth_headers(other)).json()
    response = client.patch(
        f"/api/trails/{trail['id']}",
        headers=auth_headers(other),
        json={"geometry": line(eastward(10))},
    )

    assert detail["can_replace_route"] is False
    assert response.status_code == 403


def test_manual_trails_have_no_elevation_source(
    client: TestClient, create_user: CreateUser, auth_headers: AuthHeaders
) -> None:
    trail = manual_trail(client, auth_headers(create_user()))

    assert trail["elevation_source"] is None


def test_climbs_on_a_straight_stretch_still_count_with_the_files_heights() -> None:
    # Straight east, so simplifying keeps only the ends, but over a hill 300 m high.
    points = [[13.01 + i * STEP, LATITUDE, 500.0 + 300 * np.sin(np.pi * i / 40)] for i in range(41)]

    route = prepare_route(points, "/nonexistent")

    assert len(route.coords) == 2
    assert route.elevation is not None
    assert route.elevation.gain_m == pytest.approx(300, abs=3)
    assert route.elevation.loss_m == pytest.approx(300, abs=3)
    assert route.elevation.highest_m == 800
    # The profile spans the trail's distance.
    assert route.elevation.profile[-1][0] == route.distance_m


def test_the_highest_point_is_the_highest_height_in_the_file() -> None:
    points = [[15.0, 46.0, 400], [15.01, 46.005, 500], [15.02, 46.0, 600], [15.03, 46.005, 450]]

    route = prepare_route(points, "/nonexistent")

    assert route.elevation is not None
    assert route.elevation.highest_m == 600
