"""Elevation of a route, read directly from Copernicus GLO-30 GeoTIFFs. See ADR 0005.

The route is sampled at a fixed interval, because a route's vertices are unevenly spaced. Gain and
loss come from a smoothed copy of those samples and count a climb or descent only once it exceeds
a threshold, so that DEM noise does not add up to metres nobody climbed.

A route gets elevation data only if every sample has a value. A total computed from part of a
route would look right and be wrong, so a route with any gap gets none at all.
"""

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from numpy.typing import NDArray
from rasterio.errors import RasterioError
from rasterio.windows import Window

from app.services.geo import Coord, segment_lengths_m

logger = logging.getLogger(__name__)

SAMPLE_INTERVAL_M = 30.0
# Samples on each side of a point in the moving average: 5 samples span 120 m.
SMOOTHING_HALF_WINDOW = 2
GAIN_THRESHOLD_M = 5.0
# Long routes would otherwise send tens of thousands of points to draw a small chart.
MAX_PROFILE_POINTS = 500
# Samples read from a tile at once, which limits memory use on routes that cross a whole tile.
_SAMPLES_PER_READ = 512
# Copernicus tiles do not always tag their NoData value, so also reject impossible heights.
_MIN_PLAUSIBLE_M = -500.0
_MAX_PLAUSIBLE_M = 9000.0

FloatArray = NDArray[np.float64]


@dataclass(frozen=True)
class RouteElevation:
    gain_m: int
    loss_m: int
    highest_m: int
    # [distance_m, elevation_m] pairs, smoothed.
    profile: list[list[float]]


def resample_route(
    coords: Sequence[Coord], interval_m: float = SAMPLE_INTERVAL_M
) -> tuple[FloatArray, FloatArray, FloatArray]:
    """Longitudes, latitudes and distances of points every `interval_m` along the route, always
    including its last point."""
    points = np.asarray(coords, dtype=np.float64)
    along = np.concatenate(([0.0], np.cumsum(segment_lengths_m(coords))))
    total = float(along[-1])
    distances = np.append(np.arange(0.0, total, interval_m), total)
    longitudes = np.interp(distances, along, points[:, 0])
    latitudes = np.interp(distances, along, points[:, 1])
    return longitudes, latitudes, distances


def _sample_tile(
    dataset: rasterio.DatasetReader, longitudes: FloatArray, latitudes: FloatArray
) -> FloatArray:
    """Bilinear interpolation between pixel centres. All points must be inside the tile. Near its
    edge a point uses the outermost pixels, which is under half a pixel away from the true value."""
    to_pixels = ~dataset.transform
    columns = to_pixels.a * longitudes + to_pixels.b * latitudes + to_pixels.c
    rows = to_pixels.d * longitudes + to_pixels.e * latitudes + to_pixels.f
    columns = np.clip(columns - 0.5, 0, dataset.width - 1)
    rows = np.clip(rows - 0.5, 0, dataset.height - 1)
    # The pixel to the left of and above each point, leaving room for its neighbours.
    left = np.minimum(columns.astype(int), max(dataset.width - 2, 0))
    top = np.minimum(rows.astype(int), max(dataset.height - 2, 0))
    x = columns - left
    y = rows - top

    first_column, first_row = int(left.min()), int(top.min())
    last_column = min(int(left.max()) + 1, dataset.width - 1)
    last_row = min(int(top.max()) + 1, dataset.height - 1)
    window = Window(
        first_column, first_row, last_column - first_column + 1, last_row - first_row + 1
    )
    data = dataset.read(1, window=window, masked=True).astype(np.float64).filled(np.nan)

    left_index = left - first_column
    top_index = top - first_row
    right_index = np.minimum(left_index + 1, data.shape[1] - 1)
    bottom_index = np.minimum(top_index + 1, data.shape[0] - 1)
    values: FloatArray = (
        data[top_index, left_index] * (1 - x) * (1 - y)
        + data[top_index, right_index] * x * (1 - y)
        + data[bottom_index, left_index] * (1 - x) * y
        + data[bottom_index, right_index] * x * y
    )
    values[(values < _MIN_PLAUSIBLE_M) | (values > _MAX_PLAUSIBLE_M)] = np.nan
    return values


def sample_dem(longitudes: FloatArray, latitudes: FloatArray, dem_dir: str | Path) -> FloatArray:
    """The elevation at each point, NaN where no tile has a value. Tiles are found by their
    georeferencing, not their names, and a route may cross any number of them."""
    elevations = np.full(longitudes.shape, np.nan)
    directory = Path(dem_dir)
    if not directory.is_dir():
        logger.warning("DEM directory %s does not exist", directory)
        return elevations

    for path in sorted((*directory.rglob("*.tif"), *directory.rglob("*.tiff"))):
        pending = np.isnan(elevations)
        if not pending.any():
            break
        try:
            with rasterio.open(path) as dataset:
                if dataset.crs is None or not dataset.crs.is_geographic:
                    logger.warning("Skipping DEM file %s: it is not in degrees", path)
                    continue
                bounds = dataset.bounds
                inside = (
                    (longitudes >= bounds.left)
                    & (longitudes <= bounds.right)
                    & (latitudes >= bounds.bottom)
                    & (latitudes <= bounds.top)
                )
                indexes = np.flatnonzero(pending & inside)
                for start in range(0, len(indexes), _SAMPLES_PER_READ):
                    chunk = indexes[start : start + _SAMPLES_PER_READ]
                    elevations[chunk] = _sample_tile(dataset, longitudes[chunk], latitudes[chunk])
        except (RasterioError, OSError):
            # A broken file must not fail an import: the route just gets no elevation data.
            logger.exception("Could not read DEM file %s", path)
    return elevations


def smooth(elevations: FloatArray, half_window: int = SMOOTHING_HALF_WINDOW) -> FloatArray:
    """Moving average whose window narrows towards the ends, keeping it centred. An even slope
    therefore stays exactly as it was, and the route's first and last heights are unchanged."""
    size = len(elevations)
    indexes = np.arange(size)
    half = np.minimum.reduce(
        [np.full(size, half_window), indexes, size - 1 - indexes],
    )
    running = np.concatenate(([0.0], np.cumsum(elevations)))
    result: FloatArray = (running[indexes + half + 1] - running[indexes - half]) / (2 * half + 1)
    return result


def gain_and_loss(
    elevations: Sequence[float] | FloatArray, threshold_m: float = GAIN_THRESHOLD_M
) -> tuple[float, float]:
    """Total climb and descent between turning points that differ by at least the threshold."""
    gain = loss = 0.0
    if len(elevations) == 0:
        return gain, loss
    pivot = extreme = float(elevations[0])
    trend = 0
    for raw in elevations[1:]:
        value = float(raw)
        if trend == 0:
            if abs(value - pivot) >= threshold_m:
                trend = 1 if value > pivot else -1
                extreme = value
        elif (value - extreme) * trend > 0:
            extreme = value
        elif abs(value - extreme) >= threshold_m:
            if trend > 0:
                gain += extreme - pivot
            else:
                loss += pivot - extreme
            pivot, extreme, trend = extreme, value, -trend
    if trend > 0:
        gain += extreme - pivot
    elif trend < 0:
        loss += pivot - extreme
    return gain, loss


def compute_route_elevation(coords: Sequence[Coord], dem_dir: str | Path) -> RouteElevation | None:
    """None if any part of the route lacks elevation data."""
    longitudes, latitudes, distances = resample_route(coords)
    elevations = sample_dem(longitudes, latitudes, dem_dir)
    if np.isnan(elevations).any():
        return None

    smoothed = smooth(elevations)
    gain, loss = gain_and_loss(smoothed)
    shown = np.unique(np.linspace(0, len(smoothed) - 1, MAX_PROFILE_POINTS).round().astype(int))
    return RouteElevation(
        gain_m=round(gain),
        loss_m=round(loss),
        # From the samples themselves: smoothing would cut the top off a summit.
        highest_m=round(float(elevations.max())),
        profile=[[round(float(distances[i])), round(float(smoothed[i]), 1)] for i in shown],
    )
