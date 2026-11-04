import json
import threading
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query
from geoalchemy2 import WKTElement
from sqlalchemy import exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, defer

from app.auth import CurrentUser, DbSession
from app.config import get_settings
from app.errors import ApiError
from app.models import Group, Trail, TrailSource, TrailVisibility, User
from app.permissions import (
    can_edit_trail,
    get_visible_trail,
    require_member,
    visible_trails_clause,
)
from app.rate_limit import OSM_REQUESTS, enforce
from app.schemas.common import MAX_OFFSET, Page
from app.schemas.trails import (
    MAX_NAME_LENGTH,
    MAX_RELATION_ID,
    OsmImport,
    OsmRoutePreview,
    OsmRouteSummary,
    SortOrder,
    TrailCreate,
    TrailDetail,
    TrailScope,
    TrailSort,
    TrailSummary,
    TrailUpdate,
)
from app.services.elevation import compute_route_elevation
from app.services.geo import Coord
from app.services.osm import (
    MAX_SEARCH_LENGTH,
    MAX_SEARCH_RESULTS,
    MIN_SEARCH_LENGTH,
    AssembledRoute,
    BoundingBox,
    OsmUnavailable,
    OverpassClient,
    RouteRelation,
    assemble_route,
    clean_text,
    parse_bbox,
)

router = APIRouter(prefix="/trails", tags=["trails"])

_NAME_INDEXES = {"uq_trails_public_name", "uq_trails_private_name", "uq_trails_group_name"}
_MEASUREMENTS = ("distance_m", "elevation_gain_m", "highest_point_m")
# Overpass is a shared public service and answers slowly, so few calls at a time, in this process.
MAX_CONCURRENT_OVERPASS = 3
OVERPASS_SLOT_WAIT_S = 2.0
_overpass_slots = threading.BoundedSemaphore(MAX_CONCURRENT_OVERPASS)


def get_overpass_client() -> OverpassClient:
    return OverpassClient(get_settings().overpass_url)


Overpass = Annotated[OverpassClient, Depends(get_overpass_client)]
OsmRelationId = Annotated[int, Path(gt=0, le=MAX_RELATION_ID)]


def _summary_fields(session: Session, trail: Trail, user: User) -> dict[str, Any]:
    return {
        "id": trail.id,
        "name": trail.name,
        "visibility": trail.visibility,
        "group_id": trail.group_id,
        "owner_user_id": trail.owner_user_id,
        "can_edit": can_edit_trail(session, trail, user),
        "source": trail.source,
        "distance_m": trail.distance_m,
        "elevation_gain_m": trail.elevation_gain_m,
        "archived": trail.archived_at is not None,
    }


def _to_detail(session: Session, trail: Trail, user: User) -> TrailDetail:
    owner = session.get(User, trail.owner_user_id) if trail.owner_user_id else None
    group = session.get(Group, trail.group_id) if trail.group_id else None
    geometry = session.scalar(select(func.ST_AsGeoJSON(Trail.geometry)).where(Trail.id == trail.id))
    summary = _summary_fields(session, trail, user)
    return TrailDetail(
        **summary,
        can_change_sharing=trail.owner_user_id == user.id,
        owner_name=owner.display_name if owner else None,
        group_name=group.name if group else None,
        description=trail.description,
        elevation_loss_m=trail.elevation_loss_m,
        highest_point_m=trail.highest_point_m,
        geometry=json.loads(geometry) if geometry else None,
        elevation_profile=trail.elevation_profile,
        osm_relation_id=trail.osm_relation_id,
        created_at=trail.created_at,
        updated_at=trail.updated_at,
    )


def _commit(session: Session) -> None:
    """The unique indexes are what really keeps names unique, also between concurrent requests."""
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        constraint = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
        if constraint in _NAME_INDEXES:
            raise ApiError(409, "trail_name_taken") from exc
        raise


def _resolve_group(
    session: Session, user: User, visibility: TrailVisibility, group_id: uuid.UUID | None
) -> uuid.UUID | None:
    """The group a new trail is shared with. Sharing with a group requires membership in it."""
    if visibility != TrailVisibility.GROUP:
        if group_id is not None:
            raise ApiError(422, "group_not_allowed")
        return None
    if group_id is None:
        raise ApiError(422, "group_required")
    require_member(session, group_id, user)
    return group_id


def _line_geometry(coords: Sequence[Coord]) -> WKTElement:
    points = ", ".join(f"{longitude} {latitude}" for longitude, latitude in coords)
    return WKTElement(f"LINESTRING({points})", srid=4326)


def _geojson_line(coords: Sequence[Coord]) -> dict[str, Any]:
    return {"type": "LineString", "coordinates": [list(point) for point in coords]}


def _release_connection(session: Session) -> None:
    """Ends the transaction, which returns its connection to the pool, so that slow outside work
    can't use up the pool for everyone else. It also expires loaded objects, so reading one
    afterwards takes a connection again: read what the work needs before calling this."""
    session.commit()


@contextmanager
def _overpass_slot() -> Iterator[None]:
    if not _overpass_slots.acquire(timeout=OVERPASS_SLOT_WAIT_S):
        raise ApiError(503, "osm_unavailable")
    try:
        yield
    finally:
        _overpass_slots.release()


def _fetch_route(
    overpass: OverpassClient, relation_id: int
) -> tuple[RouteRelation, AssembledRoute]:
    try:
        with _overpass_slot():
            relation = overpass.relation(relation_id)
    except OsmUnavailable as exc:
        raise ApiError(503, "osm_unavailable") from exc
    if relation is None:
        raise ApiError(404, "osm_route_not_found")
    route = assemble_route(relation.ways)
    if route is None:
        raise ApiError(422, "osm_route_without_geometry")
    return relation, route


# The fixed paths come first: the trail routes below would otherwise be tried for them.
@router.get("/osm/search", response_model=Page[OsmRouteSummary])
def search_osm(
    user: CurrentUser,
    session: DbSession,
    overpass: Overpass,
    q: Annotated[str, Query(max_length=MAX_SEARCH_LENGTH)],
    bbox: Annotated[str | None, Query(description="west,south,east,north in degrees")] = None,
) -> Page[OsmRouteSummary]:
    text = clean_text(q)
    if len(text) < MIN_SEARCH_LENGTH:
        raise ApiError(422, "osm_search_too_short")
    area: BoundingBox | None = None
    if bbox:
        try:
            area = parse_bbox(bbox)
        except ValueError as exc:
            raise ApiError(422, "invalid_bbox") from exc
    enforce(OSM_REQUESTS, user.id)
    _release_connection(session)
    try:
        with _overpass_slot():
            routes = overpass.search(text, area)
    except OsmUnavailable as exc:
        raise ApiError(503, "osm_unavailable") from exc
    return Page[OsmRouteSummary](
        items=[OsmRouteSummary.model_validate(route) for route in routes],
        total=len(routes),
        limit=MAX_SEARCH_RESULTS,
        offset=0,
    )


@router.get("/osm/{relation_id}", response_model=OsmRoutePreview)
def preview_osm_route(
    relation_id: OsmRelationId, user: CurrentUser, session: DbSession, overpass: Overpass
) -> OsmRoutePreview:
    enforce(OSM_REQUESTS, user.id)
    _release_connection(session)
    relation, route = _fetch_route(overpass, relation_id)
    return OsmRoutePreview(
        relation_id=relation.relation_id,
        name=relation.name,
        geometry=_geojson_line(route.coords),
        distance_m=round(route.distance_m),
        complete=route.complete,
        member_length_m=round(route.member_length_m),
    )


@router.post("/osm/import", response_model=TrailDetail, status_code=201)
def import_osm_route(
    body: OsmImport, user: CurrentUser, session: DbSession, overpass: Overpass
) -> TrailDetail:
    # Before contacting Overpass, so that a request that cannot succeed costs the server nothing.
    _resolve_group(session, user, body.visibility, body.group_id)
    enforce(OSM_REQUESTS, user.id)
    user_id = user.id
    _release_connection(session)

    relation, route = _fetch_route(overpass, body.relation_id)
    name = body.name or clean_text(relation.name or "")[:MAX_NAME_LENGTH].strip()
    if not name:
        raise ApiError(422, "name_required")

    elevation = compute_route_elevation(route.coords, get_settings().dem_dir)

    # A connection again. Much can happen during a minute of outside work, so check again.
    if session.get(User, user_id) is None:
        raise ApiError(401, "not_authenticated")
    group_id = _resolve_group(session, user, body.visibility, body.group_id)
    trail = Trail(
        name=name,
        visibility=body.visibility,
        group_id=group_id,
        owner_user_id=user_id,
        source=TrailSource.OSM,
        osm_relation_id=relation.relation_id,
        distance_m=round(route.distance_m),
        geometry=_line_geometry(route.coords),
        elevation_gain_m=elevation.gain_m if elevation else None,
        elevation_loss_m=elevation.loss_m if elevation else None,
        highest_point_m=elevation.highest_m if elevation else None,
        elevation_profile=elevation.profile if elevation else None,
    )
    session.add(trail)
    _commit(session)
    return _to_detail(session, trail, user)


@router.get("", response_model=Page[TrailSummary])
def list_trails(
    user: CurrentUser,
    session: DbSession,
    q: Annotated[str | None, Query(max_length=200)] = None,
    scope: TrailScope = "all",
    group_id: uuid.UUID | None = None,
    include_archived: bool = False,
    sort: TrailSort = "name",
    order: SortOrder = "asc",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0, le=MAX_OFFSET)] = 0,
) -> Page[TrailSummary]:
    conditions = [visible_trails_clause(user)]
    text = clean_text(q) if q else ""
    if text:
        conditions.append(Trail.name.icontains(text, autoescape=True))
    if scope == "public":
        conditions.append(Trail.visibility == TrailVisibility.PUBLIC)
    elif scope == "mine":
        conditions.append(Trail.owner_user_id == user.id)
    elif scope == "group":
        conditions.append(Trail.visibility == TrailVisibility.GROUP)
    if group_id is not None:
        conditions.append(Trail.group_id == group_id)
    if not include_archived:
        conditions.append(Trail.archived_at.is_(None))

    columns = {
        "name": func.lower(Trail.name),
        "distance": Trail.distance_m,
        "elevation": Trail.elevation_gain_m,
    }
    column = columns[sort]
    # Trails without elevation data stay at the end in both directions.
    sort_key = column.asc().nulls_last() if order == "asc" else column.desc().nulls_last()

    total = session.scalar(select(func.count()).select_from(Trail).where(*conditions)) or 0
    trails = session.scalars(
        select(Trail)
        .options(defer(Trail.geometry), defer(Trail.elevation_profile))
        .where(*conditions)
        .order_by(sort_key, func.lower(Trail.name), Trail.id)
        .limit(limit)
        .offset(offset)
    ).all()
    return Page[TrailSummary](
        items=[TrailSummary(**_summary_fields(session, trail, user)) for trail in trails],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("", response_model=TrailDetail, status_code=201)
def create_trail(body: TrailCreate, user: CurrentUser, session: DbSession) -> TrailDetail:
    group_id = _resolve_group(session, user, body.visibility, body.group_id)
    trail = Trail(
        name=body.name,
        description=body.description or None,
        visibility=body.visibility,
        group_id=group_id,
        owner_user_id=user.id,
        source=TrailSource.MANUAL,
        distance_m=body.distance_m,
        elevation_gain_m=body.elevation_gain_m,
        highest_point_m=body.highest_point_m,
    )
    session.add(trail)
    _commit(session)
    return _to_detail(session, trail, user)


@router.get("/{trail_id}", response_model=TrailDetail)
def read_trail(trail_id: uuid.UUID, user: CurrentUser, session: DbSession) -> TrailDetail:
    return _to_detail(session, get_visible_trail(session, trail_id, user), user)


def _get_editable_trail(session: Session, trail_id: uuid.UUID, user: User) -> Trail:
    trail = get_visible_trail(session, trail_id, user)
    if not can_edit_trail(session, trail, user):
        raise ApiError(403, "forbidden")
    return trail


@router.patch("/{trail_id}", response_model=TrailDetail)
def update_trail(
    trail_id: uuid.UUID, body: TrailUpdate, user: CurrentUser, session: DbSession
) -> TrailDetail:
    trail = _get_editable_trail(session, trail_id, user)
    changes = body.model_dump(exclude_unset=True)

    for required in ("name", "distance_m", "elevation_gain_m", "visibility"):
        if required in changes and changes[required] is None:
            raise ApiError(422, f"{required}_required")
    if trail.source == TrailSource.OSM and any(field in changes for field in _MEASUREMENTS):
        raise ApiError(422, "osm_measurements_read_only")

    visibility = changes.pop("visibility", trail.visibility)
    # A trail without an owner stays with its group: as private nobody could see it, and as
    # public nobody could edit it.
    if trail.owner_user_id is None and visibility != TrailVisibility.GROUP:
        raise ApiError(422, "trail_has_no_owner")
    # Group admins may correct a trail shared with the group, but who gets to see it is the
    # creator's decision: otherwise an admin could publish a member's trail.
    moves_group = "group_id" in changes and changes["group_id"] != trail.group_id
    if (visibility != trail.visibility or moves_group) and trail.owner_user_id != user.id:
        raise ApiError(403, "sharing_creator_only")
    if visibility == TrailVisibility.GROUP:
        group_id = changes.pop("group_id", trail.group_id)
        if group_id is None:
            raise ApiError(422, "group_required")
        if group_id != trail.group_id:
            require_member(session, group_id, user)
    else:
        if changes.pop("group_id", None) is not None:
            raise ApiError(422, "group_not_allowed")
        group_id = None

    if "description" in changes:
        changes["description"] = changes["description"] or None
    for field, value in changes.items():
        setattr(trail, field, value)
    trail.visibility = visibility
    trail.group_id = group_id
    _commit(session)
    return _to_detail(session, trail, user)


@router.post("/{trail_id}/archive", response_model=TrailDetail)
def archive_trail(trail_id: uuid.UUID, user: CurrentUser, session: DbSession) -> TrailDetail:
    """Trails are never deleted: hikes keep referring to them. Archiving twice changes nothing."""
    trail = _get_editable_trail(session, trail_id, user)
    if trail.archived_at is None:
        trail.archived_at = datetime.now(UTC)
        session.commit()
    return _to_detail(session, trail, user)


@router.post("/{trail_id}/unarchive", response_model=TrailDetail)
def unarchive_trail(trail_id: uuid.UUID, user: CurrentUser, session: DbSession) -> TrailDetail:
    trail = _get_editable_trail(session, trail_id, user)
    if trail.archived_at is not None:
        trail.archived_at = None
        session.commit()
    return _to_detail(session, trail, user)
