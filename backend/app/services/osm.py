"""Finding hiking routes in OpenStreetMap through the Overpass API, and turning a route relation
into a single line.

User input ends up inside Overpass QL, so it only ever reaches a query through the functions here:
text is escaped by `escape_ql_string`, and numbers are formatted from parsed values.
"""

import logging
import math
import unicodedata
from collections import Counter
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from app.services.geo import Coord, line_length_m

logger = logging.getLogger(__name__)

USER_AGENT = "TrailStat.si/0.1 (hiking statistics; https://github.com/marko2276/TrailStat.si)"
MAX_SEARCH_RESULTS = 50
MIN_SEARCH_LENGTH = 2
MAX_SEARCH_LENGTH = 100
# The server-side limit in the query, in seconds. The client waits a bit longer for its answer,
# since a busy server queues a query first. A live query took 40 s for a small area.
_QUERY_TIMEOUT_S = 45
_CLIENT_TIMEOUT = httpx.Timeout(75.0, connect=10.0)
# Parts of a route that are not the route itself, in OSM's route relation roles.
_SIDE_ROLES = {"alternative", "approach", "connection", "excursion", "link", "shortcut"}
# Limits the search for the longest chain. Normal routes need a fraction of this. On a pathological
# web of ways the best chain found by then is used.
_MAX_SEARCH_STEPS = 1_000_000
# The share of a route's ways the chain must contain to count as the complete route.
_COMPLETE_RATIO = 0.99


class OsmUnavailable(Exception):
    """Overpass could not answer: it is down, overloaded, or the answer made no sense."""


@dataclass(frozen=True)
class BoundingBox:
    west: float
    south: float
    east: float
    north: float


def parse_bbox(value: str) -> BoundingBox:
    """Parses `west,south,east,north` in degrees. Raises ValueError on anything else."""
    parts = value.split(",")
    if len(parts) != 4:
        raise ValueError("A bounding box has four numbers")
    west, south, east, north = (float(part) for part in parts)
    if not all(math.isfinite(number) for number in (west, south, east, north)):
        raise ValueError("Not a finite number")
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("Out of range or the wrong way round")
    return BoundingBox(west, south, east, north)


def clean_text(text: str) -> str:
    """Removes control characters and surrounding or repeated white space."""
    without_control = "".join(" " if unicodedata.category(char) == "Cc" else char for char in text)
    return " ".join(without_control.split())


def escape_regex(text: str) -> str:
    """Makes text match literally in a regular expression."""
    return "".join(f"\\{char}" if char in r"\.[](){}*+?^$|" else char for char in text)


def escape_ql_string(text: str) -> str:
    """Makes text safe inside a double-quoted Overpass QL string."""
    replacements = {"\\": "\\\\", '"': '\\"', "'": "\\'", "\n": "\\n", "\t": "\\t", "\r": "\\r"}
    return "".join(replacements.get(char, char) for char in text)


def build_search_query(text: str, bbox: BoundingBox | None) -> str:
    pattern = escape_ql_string(escape_regex(text))
    area = (
        f"({bbox.south:.7f},{bbox.west:.7f},{bbox.north:.7f},{bbox.east:.7f})"
        if bbox is not None
        else ""
    )
    return (
        f"[out:json][timeout:{_QUERY_TIMEOUT_S}];"
        f'relation["route"="hiking"]["name"~"{pattern}",i]{area};'
        f"out tags bb {MAX_SEARCH_RESULTS};"
    )


def build_relation_query(relation_id: int) -> str:
    return (
        f"[out:json][timeout:{_QUERY_TIMEOUT_S}];"
        f'relation({int(relation_id)})["route"="hiking"];'
        "out geom;"
    )


@dataclass(frozen=True)
class WayMember:
    ref: int
    role: str
    coords: list[Coord]


@dataclass(frozen=True)
class AssembledRoute:
    coords: list[Coord]
    distance_m: float
    # The length of all the ways the chain was chosen from. Larger than the distance if the route
    # has gaps or branches.
    member_length_m: float

    @property
    def complete(self) -> bool:
        return self.distance_m >= self.member_length_m * _COMPLETE_RATIO


@dataclass(frozen=True)
class _Edge:
    coords: list[Coord]
    member_index: int
    length: float

    @property
    def start(self) -> Coord:
        return self.coords[0]

    @property
    def end(self) -> Coord:
        return self.coords[-1]


def _split_at_junctions(ways: Sequence[WayMember]) -> list[_Edge]:
    """Ways do not only meet at their ends: a route can leave another way halfway along it. Each
    way is cut wherever a point is shared with another way, so that junctions are at edge ends."""
    shared = Counter(point for way in ways for point in set(way.coords))
    edges = []
    for index, way in enumerate(ways):
        start = 0
        for position in range(1, len(way.coords)):
            if position == len(way.coords) - 1 or shared[way.coords[position]] > 1:
                part = way.coords[start : position + 1]
                edges.append(_Edge(part, index, line_length_m(part)))
                start = position
    return edges


class _ChainSearch:
    """Finds the longest chain of edges that visits no junction twice. From its last junction it
    may then return to one it already passed, which completes closed loops and a stem with a loop
    at its end. Length is compared without that last edge, so that a section that splits and
    rejoins is walked once and the route continues beyond it."""

    def __init__(self, edges: Sequence[_Edge]) -> None:
        self.edges = edges
        self.steps = 0
        self.best: list[tuple[int, bool]] = []
        self.best_score = (0.0, 0.0)
        self.touched: set[int] = set()
        self.links: dict[Coord, list[tuple[int, Coord, bool]]] = {}
        for index, edge in enumerate(edges):
            self.links.setdefault(edge.start, []).append((index, edge.end, True))
            if edge.start != edge.end:
                self.links.setdefault(edge.end, []).append((index, edge.start, False))
        for links in self.links.values():
            # Longest first, so that a search cut short has still tried the most promising chains.
            links.sort(key=lambda link: (-edges[link[0]].length, link[0]))

    def _degree(self, node: Coord) -> int:
        return sum(
            2 if self.edges[index].start == self.edges[index].end else 1
            for index, _, _ in self.links[node]
        )

    def _explore(self, start: Coord) -> None:
        visited = {start}
        nodes = [start]
        path: list[tuple[int, bool]] = []
        length = 0.0
        stack: list[Iterator[tuple[int, Coord, bool]]] = [iter(self.links[start])]
        # For each junction on the path, the longest edge from it back to the path.
        closures: list[tuple[int, bool] | None] = [None]
        while stack:
            self.steps += 1
            if self.steps > _MAX_SEARCH_STEPS:
                return
            for index, other, forward in stack[-1]:
                self.touched.add(index)
                if path and path[-1][0] == index:
                    continue
                if other in visited:
                    # Links are sorted by length, so the first one found is the longest.
                    closures[-1] = closures[-1] or (index, forward)
                    continue
                visited.add(other)
                nodes.append(other)
                path.append((index, forward))
                length += self.edges[index].length
                stack.append(iter(self.links[other]))
                closures.append(None)
                break
            else:
                closure = closures.pop()
                closing_length = self.edges[closure[0]].length if closure else 0.0
                score = (round(length, 3), closing_length)
                if score > self.best_score:
                    self.best_score = score
                    self.best = [*path, closure] if closure else list(path)
                stack.pop()
                visited.discard(nodes.pop())
                if path:
                    length -= self.edges[path.pop()[0]].length

    def run(self) -> list[tuple[int, bool]]:
        # A longest chain ends at a dead end or a junction: from any other point it could continue.
        # Junctions come in the order of the relation, which normally lists its ways from start to
        # end. Of a chain's two directions the one from the first-listed end is found first and
        # kept, and that decides what counts as climbing and what as descending.
        for node in self.links:
            if self._degree(node) != 2:
                self._explore(node)
        # What remains are closed loops without any branches, so any point will do.
        for index, edge in enumerate(self.edges):
            if index not in self.touched:
                self._explore(edge.start)
        return self.best


def assemble_route(ways: Sequence[WayMember]) -> AssembledRoute | None:
    """Joins a relation's ways into one line. Ways may come in any order and direction. Where a
    route has gaps or branches, the longest connected chain is kept; `complete` tells whether
    anything was left out. None if there is no usable line at all."""
    main = [way for way in ways if way.role not in _SIDE_ROLES]
    # A route consisting only of side roles is still that route.
    candidates = main or list(ways)
    seen: set[int] = set()
    unique = []
    for way in candidates:
        points = [
            point
            for position, point in enumerate(way.coords)
            if position == 0 or point != way.coords[position - 1]
        ]
        # A way listed twice means walking it back: the trail is the way, once.
        if way.ref not in seen and len(points) >= 2:
            seen.add(way.ref)
            unique.append(WayMember(way.ref, way.role, points))
    if not unique:
        return None

    edges = _split_at_junctions(unique)
    chain = _ChainSearch(edges).run()
    if not chain:
        return None

    coords: list[Coord] = []
    for index, forward in chain:
        part = edges[index].coords if forward else edges[index].coords[::-1]
        coords.extend(part if not coords else part[1:])
    return AssembledRoute(
        coords=coords,
        distance_m=line_length_m(coords),
        member_length_m=sum(edge.length for edge in edges),
    )


@dataclass(frozen=True)
class RouteSummary:
    relation_id: int
    name: str | None
    ref: str | None
    network: str | None
    start_name: str | None
    end_name: str | None
    # west, south, east, north
    bbox: tuple[float, float, float, float] | None


@dataclass(frozen=True)
class RouteRelation:
    relation_id: int
    name: str | None
    ways: list[WayMember]


def _route_name(tags: dict[str, Any]) -> str | None:
    name = str(tags.get("name") or tags.get("ref") or "").strip()
    return name or None


def _parse_summary(element: dict[str, Any]) -> RouteSummary:
    tags = element.get("tags", {})
    bounds = element.get("bounds")
    return RouteSummary(
        relation_id=int(element["id"]),
        name=_route_name(tags),
        ref=tags.get("ref"),
        network=tags.get("network"),
        start_name=tags.get("from"),
        end_name=tags.get("to"),
        bbox=(
            (
                float(bounds["minlon"]),
                float(bounds["minlat"]),
                float(bounds["maxlon"]),
                float(bounds["maxlat"]),
            )
            if bounds
            else None
        ),
    )


def _parse_relation(element: dict[str, Any]) -> RouteRelation:
    ways = []
    for member in element.get("members", []):
        # Nodes are signposts and such. Nested relations come without geometry.
        if member.get("type") != "way":
            continue
        coords = [
            (float(point["lon"]), float(point["lat"]))
            for point in member.get("geometry") or []
            if point  # Overpass writes null for points it left out
        ]
        ways.append(WayMember(int(member["ref"]), str(member.get("role") or ""), coords))
    return RouteRelation(
        relation_id=int(element["id"]), name=_route_name(element.get("tags", {})), ways=ways
    )


class OverpassClient:
    def __init__(self, url: str, transport: httpx.BaseTransport | None = None) -> None:
        self.url = url
        self.transport = transport

    def _elements(self, query: str) -> list[dict[str, Any]]:
        try:
            with httpx.Client(
                transport=self.transport,
                timeout=_CLIENT_TIMEOUT,
                headers={"User-Agent": USER_AGENT},
            ) as client:
                response = client.post(self.url, data={"data": query})
        except httpx.HTTPError as exc:
            logger.warning("Overpass request failed: %s", exc)
            raise OsmUnavailable from exc
        # 429 means too many requests and 504 that the server is overloaded. Both come and go.
        if response.status_code != 200:
            logger.warning("Overpass answered with status %s", response.status_code)
            raise OsmUnavailable
        try:
            payload = response.json()
            elements = payload["elements"]
        except (ValueError, KeyError, TypeError) as exc:
            logger.warning("Overpass answered with something other than the expected JSON")
            raise OsmUnavailable from exc
        # A query that ran out of time or memory still answers 200, with partial or no results.
        remark = payload.get("remark")
        if remark and ("error" in str(remark).lower() or "timed out" in str(remark).lower()):
            logger.warning("Overpass could not finish a query: %s", remark)
            raise OsmUnavailable
        if not isinstance(elements, list):
            raise OsmUnavailable
        return elements

    def search(self, text: str, bbox: BoundingBox | None) -> list[RouteSummary]:
        elements = self._elements(build_search_query(text, bbox))
        try:
            routes = [_parse_summary(element) for element in elements]
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            logger.warning("Overpass returned a malformed search result")
            raise OsmUnavailable from exc
        return sorted(routes, key=lambda route: ((route.name or "").casefold(), route.relation_id))

    def relation(self, relation_id: int) -> RouteRelation | None:
        """None if there is no such relation, or it is not a hiking route."""
        elements = self._elements(build_relation_query(relation_id))
        if not elements:
            return None
        try:
            return _parse_relation(elements[0])
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            logger.warning("Overpass returned a malformed relation")
            raise OsmUnavailable from exc
