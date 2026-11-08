"""Routes the user loads, for example from a GPX or KML file read in their browser.

A recording can have tens of thousands of points, many of them GPS jitter. The route is
simplified to what can be seen on a map, and its distance and elevation are measured from that.
"""

from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from app.models import ElevationSource
from app.services.elevation import RouteElevation, compute_route_elevation, elevation_from_heights
from app.services.geo import Coord, line_length_m

# Deviations below this are taken for GPS jitter. It is a little above a phone's typical accuracy
# in the open, and well below the width of a hairpin bend.
SIMPLIFY_TOLERANCE_M = 3.0
# At most this many points are stored: more than a map or the elevation profile can show.
MAX_STORED_POINTS = 5_000

_EARTH_RADIUS_M = 6_371_008.8

IntArray = NDArray[np.intp]
FloatArray = NDArray[np.float64]


class RouteTooShort(Exception):
    """Fewer than two distinct points."""


@dataclass(frozen=True)
class PreparedRoute:
    coords: list[Coord]
    distance_m: int
    elevation: RouteElevation | None
    elevation_source: ElevationSource | None


def _local_metres(longitudes: FloatArray, latitudes: FloatArray) -> tuple[FloatArray, FloatArray]:
    """A flat approximation, only used to decide which points are worth keeping. Distances are
    always measured on the ellipsoid."""
    middle = np.radians(float(np.mean(latitudes)))
    x = np.radians(longitudes) * np.cos(middle) * _EARTH_RADIUS_M
    y = np.radians(latitudes) * _EARTH_RADIUS_M
    return x, y


def simplify(x: FloatArray, y: FloatArray, tolerance_m: float) -> IntArray:
    """Indexes of the points kept by the Ramer-Douglas-Peucker algorithm, first and last always
    included. Iterative, so a long route cannot exhaust the stack."""
    count = len(x)
    keep = np.zeros(count, dtype=bool)
    keep[0] = keep[-1] = True
    pending = [(0, count - 1)]
    while pending:
        first, last = pending.pop()
        if last - first < 2:
            continue
        inner_x = x[first + 1 : last] - x[first]
        inner_y = y[first + 1 : last] - y[first]
        dx, dy = x[last] - x[first], y[last] - y[first]
        length = float(np.hypot(dx, dy))
        if length == 0.0:
            # A loop back to the starting point: measure from that point instead of a line.
            deviation = np.hypot(inner_x, inner_y)
        else:
            deviation = np.abs(dy * inner_x - dx * inner_y) / length
        farthest = int(np.argmax(deviation))
        if deviation[farthest] > tolerance_m:
            index = first + 1 + farthest
            keep[index] = True
            pending.append((first, index))
            pending.append((index, last))
    return np.flatnonzero(keep)


def prepare_route(points: Sequence[Sequence[float]], dem_dir: str | Path) -> PreparedRoute:
    """Each point is [longitude, latitude] or [longitude, latitude, height in metres]. Heights are
    used only outside the DEM, and only if every point has one."""
    longitudes = np.array([point[0] for point in points], dtype=np.float64)
    latitudes = np.array([point[1] for point in points], dtype=np.float64)
    heights = np.array(
        [point[2] if len(point) > 2 else np.nan for point in points], dtype=np.float64
    )

    # Repeated positions, as recorded while standing still, are no route.
    if len(longitudes) > 1:
        moved = np.concatenate(([True], (np.diff(longitudes) != 0) | (np.diff(latitudes) != 0)))
        longitudes, latitudes, heights = longitudes[moved], latitudes[moved], heights[moved]
    if len(longitudes) < 2:
        raise RouteTooShort

    x, y = _local_metres(longitudes, latitudes)
    tolerance = SIMPLIFY_TOLERANCE_M
    kept = simplify(x, y, tolerance)
    while len(kept) > MAX_STORED_POINTS:
        tolerance *= 2
        kept = simplify(x, y, tolerance)

    coords: list[Coord] = [(float(longitudes[i]), float(latitudes[i])) for i in kept]
    distance_m = round(line_length_m(coords))
    if distance_m == 0:
        raise RouteTooShort

    elevation = compute_route_elevation(coords, dem_dir)
    source = ElevationSource.DEM if elevation else None
    if elevation is None:
        elevation = _elevation_from_all_heights(longitudes, latitudes, heights, distance_m)
        source = ElevationSource.FILE if elevation else None
    return PreparedRoute(coords, distance_m, elevation, source)


def _elevation_from_all_heights(
    longitudes: FloatArray, latitudes: FloatArray, heights: FloatArray, distance_m: int
) -> RouteElevation | None:
    """From every point, not only those kept: simplifying looks at the map, so it drops points
    on a straight stretch, with the climbs and dips they record. The profile is then stretched
    to the simplified route's distance, which is the trail's."""
    all_coords: list[Coord] = list(zip(longitudes.tolist(), latitudes.tolist(), strict=True))
    elevation = elevation_from_heights(all_coords, heights.tolist())
    if elevation is None:
        return None
    full_length = line_length_m(all_coords)
    scale = distance_m / full_length if full_length > 0 else 1.0
    profile = [[round(along * scale), height] for along, height in elevation.profile]
    return replace(elevation, profile=profile)
