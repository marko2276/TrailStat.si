import { useMemo, useState } from "react";
import type { LineString } from "./api";
import { measureRoute, pointAt, shareNearest } from "./routeMeasure";
import type { LngLat } from "./routeMeasure";

/**
 * One position along a trail, shared by its map and its elevation profile: pointing at either
 * shows the same place on both.
 */
export function useRoutePosition(
  geometry: LineString | null | undefined,
  profile: [number, number][] | null | undefined,
) {
  const [share, setShare] = useState<number | null>(null);
  const route = useMemo(() => (geometry ? measureRoute(geometry.coordinates) : null), [geometry]);
  const profileLength = profile && profile.length >= 2 ? profile[profile.length - 1][0] : 0;
  // Without a profile there is nothing to link the map with.
  const linked = route !== null && route.length > 0 && profileLength > 0;

  return {
    /** For the map: where to show the marker. */
    marker: linked && share !== null ? pointAt(route, share) : null,
    /** For the map: the pointer is on the trail at this position, or left it. */
    onRoutePointer: linked
      ? (position: LngLat | null) =>
          setShare(position === null ? null : shareNearest(route, position))
      : undefined,
    /** For the profile: the distance to mark. */
    selectedDistance: linked && share !== null ? share * profileLength : null,
    /** For the profile: the pointer is at this distance, or left it. */
    onSelectDistance: linked
      ? (metres: number | null) => setShare(metres === null ? null : metres / profileLength)
      : undefined,
  };
}
