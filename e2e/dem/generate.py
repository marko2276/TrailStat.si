"""TEST ONLY. Writes the synthetic elevation tile used by the end-to-end tests.

It has the same format as a Copernicus GLO-30 tile (float32, 1 arc second, WGS 84), and covers the
area of relation 19446684, the route in backend/tests/fixtures. The height depends only on the
latitude, so the elevation of that route is predictable. These are not real heights.

Run with an image that has rasterio, in this directory, as: python generate.py
"""

import numpy as np
import rasterio
from rasterio.transform import from_origin

ARC_SECOND = 1 / 3600
WEST, NORTH = 13.82, 46.42
WIDTH, HEIGHT = 144, 216
METRES_PER_DEGREE_SOUTH = 55_000
BASE_M = 1000

rows = np.arange(HEIGHT, dtype=np.float64)
latitudes = NORTH - (rows + 0.5) * ARC_SECOND
heights = BASE_M + (46.41 - latitudes) * METRES_PER_DEGREE_SOUTH
data = np.repeat(heights[:, np.newaxis], WIDTH, axis=1).astype(np.float32)

with rasterio.open(
    "synthetic_N46_E013.tif",
    "w",
    driver="GTiff",
    width=WIDTH,
    height=HEIGHT,
    count=1,
    dtype="float32",
    crs="EPSG:4326",
    transform=from_origin(WEST, NORTH, ARC_SECOND, ARC_SECOND),
    compress="deflate",
    predictor=3,
) as dataset:
    dataset.write(data, 1)
