"""Geodesic measurements on the WGS84 ellipsoid. Never measure distances in degrees."""

from collections.abc import Sequence

import numpy as np
from numpy.typing import NDArray
from pyproj import Geod

# (longitude, latitude), the order GeoJSON and PostGIS use.
Coord = tuple[float, float]

_GEOD = Geod(ellps="WGS84")


def segment_lengths_m(coords: Sequence[Coord]) -> NDArray[np.float64]:
    """The length in metres of each segment between consecutive coordinates."""
    points = np.asarray(coords, dtype=np.float64)
    _, _, lengths = _GEOD.inv(points[:-1, 0], points[:-1, 1], points[1:, 0], points[1:, 1])
    return np.asarray(lengths, dtype=np.float64)


def line_length_m(coords: Sequence[Coord]) -> float:
    if len(coords) < 2:
        return 0.0
    return float(segment_lengths_m(coords).sum())
