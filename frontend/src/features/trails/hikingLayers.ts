import type { LineLayerSpecification, Map as MapLibreMap } from "maplibre-gl";

/**
 * Footpaths and tracks drawn as on a hiking map, from the vector tiles the base map already
 * loads: no other service, and no other request. The base style shows them faintly, and only up
 * close. Marked hiking routes are not in these tiles, so this shows paths, not routes.
 */

// The OpenMapTiles schema, which OpenFreeMap serves. Another style may not have it.
const TILES = "openmaptiles";
const PATH_COLOUR = "#c0392b";
const TRACK_COLOUR = "#8a5a2b";

const width = ["interpolate", ["linear"], ["zoom"], 12, 1, 15, 2, 18, 3.5] as const;

export const HIKING_LAYERS: LineLayerSpecification[] = [
  {
    id: "hiking-tracks",
    type: "line",
    source: TILES,
    "source-layer": "transportation",
    minzoom: 12,
    filter: ["==", ["get", "class"], "track"],
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": TRACK_COLOUR,
      "line-width": width as unknown as number,
      "line-dasharray": [3, 1.5],
    },
  },
  {
    id: "hiking-paths",
    type: "line",
    source: TILES,
    "source-layer": "transportation",
    minzoom: 12,
    // Footpaths, mountain paths and steps; cycle paths are no hiking trails.
    filter: [
      "all",
      ["==", ["get", "class"], "path"],
      ["!", ["in", ["get", "subclass"], ["literal", ["cycleway", "pedestrian"]]]],
    ],
    layout: { "line-cap": "butt", "line-join": "round" },
    paint: {
      "line-color": PATH_COLOUR,
      "line-width": width as unknown as number,
      "line-dasharray": [2, 1.5],
    },
  },
];

/**
 * Adds the hiking layers below the first label, so names stay readable, and below anything added
 * later, such as the trail's own line. Does nothing on a style without those tiles.
 */
export function addHikingLayers(map: MapLibreMap) {
  const style = map.getStyle();
  if (style.sources?.[TILES]?.type !== "vector") return;
  const firstLabel = style.layers.find((layer) => layer.type === "symbol")?.id;
  for (const layer of HIKING_LAYERS) map.addLayer(layer, firstLabel);
}
