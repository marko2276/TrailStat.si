"""Elevation from GeoTIFFs. The tiles are built here, shaped and georeferenced like Copernicus
GLO-30: 32-bit floats, EPSG:4326, no NoData tag, and pixel edges half a pixel off whole degrees."""

from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest
import rasterio
from numpy.typing import NDArray
from rasterio.transform import from_origin

from app.services.elevation import (
    GAIN_THRESHOLD_M,
    MAX_PROFILE_POINTS,
    SAMPLE_INTERVAL_M,
    compute_route_elevation,
    gain_and_loss,
    resample_route,
    sample_dem,
    smooth,
)
from app.services.geo import line_length_m

PIXEL = 1 / 3600
HALF_PIXEL = PIXEL / 2
SIZE = 3600


def write_tile(
    path: Path,
    west: int,
    north: int,
    heights: Callable[[NDArray[np.float64], NDArray[np.float64]], NDArray[np.float64]],
    size: int = SIZE,
    nodata: float | None = None,
) -> None:
    """A tile whose top-left corner is near whole degrees, with heights as a function of the
    longitudes and latitudes of its pixel centres."""
    origin_west = west - HALF_PIXEL
    origin_north = north + HALF_PIXEL
    columns, rows = np.meshgrid(np.arange(size), np.arange(size))
    longitudes = (origin_west + (columns + 0.5) * PIXEL).astype(np.float64)
    latitudes = (origin_north - (rows + 0.5) * PIXEL).astype(np.float64)
    data = heights(longitudes, latitudes).astype("float32")
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=size,
        height=size,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(origin_west, origin_north, PIXEL, PIXEL),
        nodata=nodata,
    ) as dataset:
        dataset.write(data, 1)


def east_slope(
    metres_per_degree: float, base: float = 1000.0, west: float = 13.0
) -> Callable[[NDArray[np.float64], NDArray[np.float64]], NDArray[np.float64]]:
    def heights(
        longitudes: NDArray[np.float64], latitudes: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        return base + (longitudes - west) * metres_per_degree

    return heights


# The small tile reaches from 13 to 13.1 degrees east, and from 46.9 to 47 north.
SMALL = 360
LATITUDE = 46.95


def test_samples_a_known_height(tmp_path: Path) -> None:
    write_tile(tmp_path / "a.tif", 13, 47, east_slope(2000), SMALL)

    result = sample_dem(np.array([13.05]), np.array([LATITUDE]), tmp_path)

    # Between pixels, so this also shows that the half-pixel offset is handled.
    assert result[0] == pytest.approx(1100.0, abs=0.01)


def test_interpolates_between_pixel_centres_on_both_axes(tmp_path: Path) -> None:
    def tilted(
        longitudes: NDArray[np.float64], latitudes: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        return 1000 + (longitudes - 13) * 5000 + (47 - latitudes) * 3000

    write_tile(tmp_path / "a.tif", 13, 47, tilted, SMALL)
    lons = np.array([13.01234, 13.05678, 13.09])
    lats = np.array([46.98765, 46.91234, 46.95])

    result = sample_dem(lons, lats, tmp_path)

    assert result == pytest.approx(1000 + (lons - 13) * 5000 + (47 - lats) * 3000, abs=0.01)


def test_ascending_a_known_slope_gives_the_exact_gain(tmp_path: Path) -> None:
    # 2000 m per degree of longitude, so 13.01 to 13.09 east climbs exactly 160 m.
    write_tile(tmp_path / "a.tif", 13, 47, east_slope(2000), SMALL)

    result = compute_route_elevation([(13.01, LATITUDE), (13.09, LATITUDE)], tmp_path)

    assert result is not None
    assert result.gain_m == 160
    assert result.loss_m == 0
    assert result.highest_m == 1180
    assert result.profile[0][1] == pytest.approx(1020, abs=0.1)
    assert result.profile[-1][1] == pytest.approx(1180, abs=0.1)


def test_descending_the_same_slope_counts_as_loss(tmp_path: Path) -> None:
    write_tile(tmp_path / "a.tif", 13, 47, east_slope(2000), SMALL)

    result = compute_route_elevation([(13.09, LATITUDE), (13.01, LATITUDE)], tmp_path)

    assert result is not None
    assert (result.gain_m, result.loss_m) == (0, 160)
    assert result.highest_m == 1180


def test_up_and_down_counts_both_ways(tmp_path: Path) -> None:
    write_tile(tmp_path / "a.tif", 13, 47, east_slope(2000), SMALL)
    route = [(13.01, LATITUDE), (13.05, LATITUDE), (13.03, LATITUDE)]

    result = compute_route_elevation(route, tmp_path)

    assert result is not None
    assert result.gain_m == pytest.approx(80, abs=2)
    assert result.loss_m == pytest.approx(40, abs=2)


def test_noise_on_flat_ground_does_not_add_up(tmp_path: Path) -> None:
    generator = np.random.default_rng(42)

    def noisy(
        longitudes: NDArray[np.float64], latitudes: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        return 500 + generator.uniform(-2, 2, longitudes.shape)

    write_tile(tmp_path / "a.tif", 13, 47, noisy, SMALL)
    # Diagonally, so that the route crosses many pixels.
    route = [(13.005, 46.905), (13.095, 46.995)]

    result = compute_route_elevation(route, tmp_path)
    assert result is not None

    # Without the filtering, the same samples add up to many times the threshold.
    longitudes, latitudes, _ = resample_route(route)
    raw = sample_dem(longitudes, latitudes, tmp_path)
    assert np.abs(np.diff(raw)).sum() / 2 > 100

    assert result.gain_m <= 2
    assert result.loss_m <= 2


def test_smoothing_is_what_stops_noise_larger_than_the_threshold(tmp_path: Path) -> None:
    generator = np.random.default_rng(42)

    def noisy(
        longitudes: NDArray[np.float64], latitudes: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        return 500 + generator.uniform(-5, 5, longitudes.shape)

    write_tile(tmp_path / "a.tif", 13, 47, noisy, SMALL)
    # Along a column of pixel centres, where interpolation does not average the noise away.
    route = [(13.05, 46.905), (13.05, 46.995)]

    result = compute_route_elevation(route, tmp_path)
    assert result is not None

    longitudes, latitudes, _ = resample_route(route)
    unsmoothed_gain, _ = gain_and_loss(sample_dem(longitudes, latitudes, tmp_path))
    assert unsmoothed_gain > 50
    assert result.gain_m < unsmoothed_gain / 3


def test_noise_does_not_inflate_a_real_climb(tmp_path: Path) -> None:
    generator = np.random.default_rng(7)
    slope = east_slope(2000)

    def noisy(
        longitudes: NDArray[np.float64], latitudes: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        return slope(longitudes, latitudes) + generator.uniform(-2, 2, longitudes.shape)

    write_tile(tmp_path / "a.tif", 13, 47, noisy, SMALL)

    result = compute_route_elevation([(13.01, LATITUDE), (13.09, LATITUDE)], tmp_path)

    assert result is not None
    assert result.gain_m == pytest.approx(160, abs=6)
    assert result.loss_m <= 2


def test_route_across_adjacent_tiles_continues_at_the_seam(tmp_path: Path) -> None:
    # The file names say nothing about the location, and the route starts in the later file.
    slope = east_slope(100)
    write_tile(tmp_path / "z_west.tif", 13, 47, slope, 3600)
    write_tile(tmp_path / "a_east.tif", 14, 47, slope, 3600)

    route = [(13.9, LATITUDE), (14.1, LATITUDE)]
    result = compute_route_elevation(route, tmp_path)

    assert result is not None
    assert result.gain_m == 20
    assert result.loss_m == 0
    # Nothing jumps where the tiles meet.
    heights = np.array([height for _, height in result.profile])
    assert np.abs(np.diff(heights)).max() < 0.2


def test_route_across_four_tiles_at_a_corner(tmp_path: Path) -> None:
    def tilted(
        longitudes: NDArray[np.float64], latitudes: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        return 1000 + (longitudes - 13) * 100 + (latitudes - 46) * 100

    write_tile(tmp_path / "nw.tif", 13, 47, tilted, 3600)
    write_tile(tmp_path / "ne.tif", 14, 47, tilted, 3600)
    write_tile(tmp_path / "sw.tif", 13, 46, tilted, 3600)
    write_tile(tmp_path / "se.tif", 14, 46, tilted, 3600)

    result = compute_route_elevation([(13.9, 45.9), (14.1, 46.1)], tmp_path)

    assert result is not None
    assert result.gain_m == 40


def test_tiles_are_also_found_in_subdirectories(tmp_path: Path) -> None:
    (tmp_path / "region").mkdir()
    write_tile(tmp_path / "region" / "a.tif", 13, 47, east_slope(2000), SMALL)

    assert compute_route_elevation([(13.01, LATITUDE), (13.02, LATITUDE)], tmp_path) is not None


def test_route_outside_coverage_has_no_elevation(tmp_path: Path) -> None:
    write_tile(tmp_path / "a.tif", 13, 47, east_slope(2000), SMALL)

    assert compute_route_elevation([(20.0, 40.0), (20.01, 40.0)], tmp_path) is None


def test_route_leaving_coverage_partway_has_no_elevation(tmp_path: Path) -> None:
    write_tile(tmp_path / "a.tif", 13, 47, east_slope(2000), SMALL)

    # Half of a route must not produce a total that looks complete.
    assert compute_route_elevation([(13.05, LATITUDE), (13.2, LATITUDE)], tmp_path) is None


def test_missing_or_empty_dem_directory_has_no_elevation(tmp_path: Path) -> None:
    route = [(13.01, LATITUDE), (13.02, LATITUDE)]

    assert compute_route_elevation(route, tmp_path) is None
    assert compute_route_elevation(route, tmp_path / "does-not-exist") is None


def test_nodata_value_on_the_route_gives_no_elevation(tmp_path: Path) -> None:
    def with_hole(
        longitudes: NDArray[np.float64], latitudes: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        heights = 1000 + (longitudes - 13) * 2000
        heights[(longitudes > 13.04) & (longitudes < 13.06)] = -9999
        return heights

    write_tile(tmp_path / "a.tif", 13, 47, with_hole, SMALL, nodata=-9999)

    assert compute_route_elevation([(13.01, LATITUDE), (13.09, LATITUDE)], tmp_path) is None
    # A route that avoids the hole is fine.
    assert compute_route_elevation([(13.01, LATITUDE), (13.03, LATITUDE)], tmp_path) is not None


def test_untagged_void_value_gives_no_elevation(tmp_path: Path) -> None:
    def with_hole(
        longitudes: NDArray[np.float64], latitudes: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        heights = 1000 + (longitudes - 13) * 2000
        heights[(longitudes > 13.04) & (longitudes < 13.06)] = -32767
        return heights

    write_tile(tmp_path / "a.tif", 13, 47, with_hole, SMALL)

    assert compute_route_elevation([(13.01, LATITUDE), (13.09, LATITUDE)], tmp_path) is None


def test_a_second_tile_can_fill_what_another_lacks(tmp_path: Path) -> None:
    write_tile(
        tmp_path / "a.tif", 13, 47, lambda lon, lat: np.full(lon.shape, -9999.0), SMALL, -9999
    )
    write_tile(tmp_path / "b.tif", 13, 47, east_slope(2000), SMALL)

    result = sample_dem(np.array([13.05]), np.array([LATITUDE]), tmp_path)

    assert result[0] == pytest.approx(1100.0, abs=0.01)


def test_broken_file_is_skipped(tmp_path: Path) -> None:
    (tmp_path / "broken.tif").write_bytes(b"this is not a GeoTIFF")
    route = [(13.01, LATITUDE), (13.09, LATITUDE)]

    assert compute_route_elevation(route, tmp_path) is None

    write_tile(tmp_path / "z.tif", 13, 47, east_slope(2000), SMALL)
    assert compute_route_elevation(route, tmp_path) is not None


def test_file_not_in_degrees_is_skipped(tmp_path: Path) -> None:
    with rasterio.open(
        tmp_path / "projected.tif",
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="float32",
        crs="EPSG:32633",
        transform=from_origin(13.0, 47.0, 0.1, 0.1),
    ) as dataset:
        dataset.write(np.full((2, 2), 1000, dtype="float32"), 1)

    assert np.isnan(sample_dem(np.array([13.05]), np.array([46.95]), tmp_path)).all()


def test_highest_point_keeps_a_summit_that_smoothing_would_cut_off(tmp_path: Path) -> None:
    def peak(
        longitudes: NDArray[np.float64], latitudes: NDArray[np.float64]
    ) -> NDArray[np.float64]:
        return 2000 - np.abs(longitudes - 13.05) * 50000

    write_tile(tmp_path / "a.tif", 13, 47, peak, SMALL)

    result = compute_route_elevation([(13.04, LATITUDE), (13.06, LATITUDE)], tmp_path)

    assert result is not None
    assert result.highest_m == pytest.approx(2000, abs=15)
    assert max(height for _, height in result.profile) < result.highest_m


def test_resampling_uses_the_fixed_interval_and_true_distance() -> None:
    # A degree of longitude at 46 degrees north is about 77 km, while a degree of latitude is
    # 111 km. A calculation in degrees would treat them as equal.
    east = [(13.0, 46.0), (13.01, 46.0)]
    north = [(13.0, 46.0), (13.0, 46.01)]

    assert line_length_m(east) == pytest.approx(774.6, abs=0.1)
    assert line_length_m(north) == pytest.approx(1111.5, abs=0.1)

    _, _, distances = resample_route(north)
    assert distances[0] == 0
    assert distances[-1] == pytest.approx(line_length_m(north))
    assert np.diff(distances)[:-1] == pytest.approx(SAMPLE_INTERVAL_M)


def test_route_shorter_than_the_interval_still_has_both_ends(tmp_path: Path) -> None:
    write_tile(tmp_path / "a.tif", 13, 47, east_slope(2000), SMALL)

    result = compute_route_elevation([(13.05, LATITUDE), (13.0501, LATITUDE)], tmp_path)

    assert result is not None
    assert len(result.profile) == 2
    assert result.gain_m == 0


def test_profile_of_a_long_route_is_thinned_out_but_keeps_both_ends(tmp_path: Path) -> None:
    write_tile(tmp_path / "a.tif", 13, 47, east_slope(100), 3600)
    route = [(13.0, 46.5), (13.9, 46.5)]

    result = compute_route_elevation(route, tmp_path)

    assert result is not None
    assert len(result.profile) <= MAX_PROFILE_POINTS
    assert result.profile[0][0] == 0
    assert result.profile[-1][0] == round(line_length_m(route))
    # The totals still come from all the samples.
    assert result.gain_m == 90


def test_smooth_leaves_a_slope_and_the_ends_unchanged() -> None:
    slope = np.arange(20, dtype=np.float64) * 3

    assert smooth(slope) == pytest.approx(slope)

    bumpy = np.array([0.0, 10.0, 0.0, 10.0, 0.0, 10.0, 7.0])
    assert smooth(bumpy)[0] == 0.0
    assert smooth(bumpy)[-1] == 7.0
    assert smooth(bumpy)[3] == pytest.approx(30 / 5)


@pytest.mark.parametrize("size", [1, 2, 3, 4, 5, 6])
def test_smooth_handles_very_short_routes(size: int) -> None:
    values = np.arange(size, dtype=np.float64)

    assert smooth(values) == pytest.approx(values)


@pytest.mark.parametrize(
    ("heights", "gain", "loss"),
    [
        ([], 0, 0),
        ([100], 0, 0),
        ([100, 100, 100], 0, 0),
        # Up and down within the threshold
        ([100, 104, 100, 104, 100, 104], 0, 0),
        ([100, 200], 100, 0),
        ([200, 100], 0, 100),
        ([100, 150, 120, 180], 110, 30),
        # A dip smaller than the threshold does not break a climb in two.
        ([100, 150, 148, 200], 100, 0),
        # A rise of exactly the threshold counts.
        ([100, 100 + GAIN_THRESHOLD_M], GAIN_THRESHOLD_M, 0),
        ([100, 100 + GAIN_THRESHOLD_M - 0.1], 0, 0),
        # The route may end on a descent that started from the top.
        ([100, 200, 150], 100, 50),
    ],
)
def test_gain_and_loss(heights: list[float], gain: float, loss: float) -> None:
    assert gain_and_loss(heights) == pytest.approx((gain, loss))
