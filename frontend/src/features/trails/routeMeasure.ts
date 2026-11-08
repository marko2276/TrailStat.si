/**
 * Positions along a route, to link the elevation profile with the map. Positions are shares of
 * the route's length, from 0 at the start to 1 at the end: the profile's distances are measured
 * on the server, slightly differently, so metres would drift apart along a long route.
 */

export type LngLat = [number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance, close enough to the server's ellipsoid for a share of the length. */
function metresBetween([lon1, lat1]: LngLat, [lon2, lat2]: LngLat): number {
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface MeasuredRoute {
  points: LngLat[];
  /** Distance from the start to each point. */
  along: number[];
  length: number;
}

export function measureRoute(coordinates: number[][]): MeasuredRoute {
  const points = coordinates.map(([lon, lat]) => [lon, lat] as LngLat);
  const along = [0];
  for (let i = 1; i < points.length; i++) {
    along.push(along[i - 1] + metresBetween(points[i - 1], points[i]));
  }
  return { points, along, length: along[along.length - 1] ?? 0 };
}

/** The point at this share of the route's length. */
export function pointAt(route: MeasuredRoute, share: number): LngLat | null {
  const { points, along, length } = route;
  if (points.length === 0) return null;
  if (points.length === 1 || length === 0) return points[0];
  const target = Math.min(Math.max(share, 0), 1) * length;
  let i = 1;
  while (i < along.length - 1 && along[i] < target) i++;
  const segment = along[i] - along[i - 1];
  const t = segment === 0 ? 0 : (target - along[i - 1]) / segment;
  const [lon1, lat1] = points[i - 1];
  const [lon2, lat2] = points[i];
  return [lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t];
}

/** The share of the route's length at the route's point nearest to this position. */
export function shareNearest(route: MeasuredRoute, position: LngLat): number {
  const { points, along, length } = route;
  if (points.length < 2 || length === 0) return 0;
  // Flat metres around the position: enough to find the nearest point on a nearby line.
  const scaleX = Math.cos(radians(position[1]));
  const toXY = ([lon, lat]: LngLat) => [(lon - position[0]) * scaleX, lat - position[1]];
  let best = { distance: Infinity, metres: 0 };
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = toXY(points[i - 1]);
    const [bx, by] = toXY(points[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const span = dx * dx + dy * dy;
    // The position is the origin: project it onto the segment.
    const t = span === 0 ? 0 : Math.min(Math.max(-(ax * dx + ay * dy) / span, 0), 1);
    const x = ax + dx * t;
    const y = ay + dy * t;
    const distance = x * x + y * y;
    if (distance < best.distance) {
      best = { distance, metres: along[i - 1] + (along[i] - along[i - 1]) * t };
    }
  }
  return best.metres / length;
}
