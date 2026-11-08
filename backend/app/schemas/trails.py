import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, Field, StringConstraints

from app.models import ElevationSource, TrailSource, TrailVisibility
from app.schemas.common import ApiModel, no_control_characters, no_stray_control_characters

MAX_NAME_LENGTH = 200
MAX_DISTANCE_M = 10_000_000
MAX_ELEVATION_GAIN_M = 1_000_000
# Below the Dead Sea to above Everest.
MIN_HEIGHT_M = -500
MAX_HEIGHT_M = 9000
# Far above any OSM relation ID today, and low enough to always fit the database column.
MAX_RELATION_ID = 10**15
# A day's recording at one point a second is about 86,000 points. The browser thins out more.
MAX_ROUTE_POINTS = 100_000


TrailName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NAME_LENGTH),
    AfterValidator(no_control_characters),
]
Description = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=5000),
    AfterValidator(no_stray_control_characters),
]
DistanceM = Annotated[int, Field(gt=0, le=MAX_DISTANCE_M)]
ElevationGainM = Annotated[int, Field(ge=0, le=MAX_ELEVATION_GAIN_M)]
HeightM = Annotated[int, Field(ge=MIN_HEIGHT_M, le=MAX_HEIGHT_M)]
RelationId = Annotated[int, Field(gt=0, le=MAX_RELATION_ID)]
Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
Height = Annotated[float, Field(allow_inf_nan=False)]
Position = tuple[Longitude, Latitude] | tuple[Longitude, Latitude, Height]


class RouteGeometry(ApiModel):
    """A GeoJSON LineString. A third value in a position is its height in metres, used for
    elevation only where the DEM has none."""

    type: Literal["LineString"]
    coordinates: list[Position] = Field(min_length=2, max_length=MAX_ROUTE_POINTS)


class TrailSummary(ApiModel):
    id: uuid.UUID
    name: str
    visibility: TrailVisibility
    group_id: uuid.UUID | None
    owner_user_id: uuid.UUID | None
    can_edit: bool
    source: TrailSource
    distance_m: int
    elevation_gain_m: int | None
    archived: bool


class TrailDetail(TrailSummary):
    can_change_sharing: bool
    # Whether a new route can be loaded: on manual and file trails, until others' hikes use it.
    can_replace_route: bool
    # False for imported trails, and once a hike on the trail counts someone else's statistics.
    can_edit_measurements: bool
    # Null after the creator deleted their account.
    owner_name: str | None
    group_name: str | None
    description: str | None
    elevation_loss_m: int | None
    highest_point_m: int | None
    # Null when typed in by hand, or when there are none.
    elevation_source: ElevationSource | None
    # A GeoJSON LineString. Null for manual trails.
    geometry: dict[str, Any] | None
    # [[distance_m, elevation_m], ...]. Null for manual trails and outside the elevation data.
    elevation_profile: list[list[float]] | None
    osm_relation_id: int | None
    created_at: datetime
    updated_at: datetime


class TrailCreate(ApiModel):
    """With a route, distance and elevation come from it and must not be sent. Without one,
    distance and elevation gain are required."""

    name: TrailName
    distance_m: DistanceM | None = None
    elevation_gain_m: ElevationGainM | None = None
    geometry: RouteGeometry | None = None
    description: Description | None = None
    highest_point_m: HeightM | None = None
    visibility: TrailVisibility
    group_id: uuid.UUID | None = None


class TrailUpdate(ApiModel):
    """Only fields present in the request change. Description and highest point can be cleared
    with null. Distance and elevation of a trail with a route come from it, so they can only be
    changed on manual trails. A new route can be loaded on manual and file trails, but not
    removed."""

    name: TrailName | None = None
    description: Description | None = None
    distance_m: DistanceM | None = None
    elevation_gain_m: ElevationGainM | None = None
    highest_point_m: HeightM | None = None
    geometry: RouteGeometry | None = None
    visibility: TrailVisibility | None = None
    group_id: uuid.UUID | None = None


class RoutePreviewRequest(ApiModel):
    geometry: RouteGeometry


class RoutePreview(ApiModel):
    """What a trail with this route would get, without saving anything."""

    # Simplified: what would be stored.
    geometry: dict[str, Any]
    distance_m: int
    elevation_gain_m: int | None
    elevation_loss_m: int | None
    highest_point_m: int | None
    elevation_profile: list[list[float]] | None
    elevation_source: ElevationSource | None


class OsmRouteSummary(ApiModel):
    relation_id: int
    name: str | None
    ref: str | None
    network: str | None
    start_name: str | None
    end_name: str | None
    # [west, south, east, north]
    bbox: tuple[float, float, float, float] | None


class OsmRoutePreview(ApiModel):
    relation_id: int
    name: str | None
    # A GeoJSON LineString.
    geometry: dict[str, Any]
    distance_m: int
    # False if gaps or branches left part of the route out of the geometry.
    complete: bool
    # The length of all the route's ways, to compare with `distance_m` if not complete.
    member_length_m: int


class OsmImport(ApiModel):
    relation_id: RelationId
    # Defaults to the name in OSM.
    name: TrailName | None = None
    visibility: TrailVisibility
    group_id: uuid.UUID | None = None


TrailSort = Literal["name", "distance", "elevation"]
TrailScope = Literal["all", "public", "mine", "group"]
SortOrder = Literal["asc", "desc"]
