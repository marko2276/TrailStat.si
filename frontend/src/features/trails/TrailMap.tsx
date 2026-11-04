import "maplibre-gl/dist/maplibre-gl.css";
import { LngLatBounds, Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { GeoJSONSource, GeoJSONSourceSpecification } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LineString } from "./api";
import type { TrailMapProps } from "./LazyTrailMap";

// No API key, and not openstreetmap.org's tile servers, whose policy forbids use in apps.
const STYLE_URL =
  import.meta.env.VITE_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty";
const ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>';
const SLOVENIA: [number, number] = [14.8, 46.15];
const ROUTE_SOURCE = "route";
const ROUTE_COLOUR = "#2f6b4f"; // --color-primary. Map layers cannot read CSS variables.

function asFeature(geometry: LineString | null | undefined): GeoJSONSourceSpecification["data"] {
  return {
    type: "Feature",
    properties: {},
    geometry: geometry ?? { type: "LineString", coordinates: [] },
  };
}

function fitToLine(map: MapLibreMap, geometry: LineString) {
  if (geometry.coordinates.length === 0) return;
  const bounds = new LngLatBounds();
  geometry.coordinates.forEach((point) => bounds.extend(point));
  map.fitBounds(bounds, { padding: 32, animate: false, maxZoom: 15 });
}

/** The visible area as "west,south,east,north". A zoomed-out map can show more than the world. */
function visibleArea(map: MapLibreMap): string {
  const bounds = map.getBounds();
  return [
    Math.max(bounds.getWest(), -180),
    Math.max(bounds.getSouth(), -90),
    Math.min(bounds.getEast(), 180),
    Math.min(bounds.getNorth(), 90),
  ]
    .map((value) => value.toFixed(5))
    .join(",");
}

/** Only ever loaded through LazyTrailMap, to keep MapLibre out of the first page's bundle. */
export default function TrailMap({ geometry, label, onVisibleAreaChange }: TrailMapProps) {
  const { t } = useTranslation("trails");
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const onChange = useRef(onVisibleAreaChange);
  const initialGeometry = useRef(geometry);

  useEffect(() => {
    onChange.current = onVisibleAreaChange;
  }, [onVisibleAreaChange]);

  useEffect(() => {
    if (!container.current) return;
    let map: MapLibreMap;
    try {
      // A bundler cannot follow how MapLibre finds its worker by itself: the map would stay empty.
      setWorkerUrl(workerUrl);
      map = new MapLibreMap({
        container: container.current,
        style: STYLE_URL,
        center: SLOVENIA,
        zoom: 7,
        attributionControl: { compact: false, customAttribution: ATTRIBUTION },
      });
    } catch {
      // No WebGL on this device.
      const timer = setTimeout(() => setFailed(true));
      return () => clearTimeout(timer);
    }
    mapRef.current = map;
    // Known at once, while "load" also waits for the first tiles, which a slow connection delays.
    onChange.current?.(visibleArea(map));

    map.on("load", () => {
      map.addSource(ROUTE_SOURCE, { type: "geojson", data: asFeature(initialGeometry.current) });
      const line = { "line-cap": "round", "line-join": "round" } as const;
      // A white outline keeps the line readable over woods and meadows of a similar colour.
      map.addLayer({
        id: "route-outline",
        type: "line",
        source: ROUTE_SOURCE,
        layout: line,
        paint: { "line-color": "#ffffff", "line-width": 7 },
      });
      map.addLayer({
        id: "route",
        type: "line",
        source: ROUTE_SOURCE,
        layout: line,
        paint: { "line-color": ROUTE_COLOUR, "line-width": 4 },
      });
      if (initialGeometry.current) fitToLine(map, initialGeometry.current);
      setLoaded(true);
    });
    map.on("moveend", () => onChange.current?.(visibleArea(map)));

    return () => {
      mapRef.current = null;
      setLoaded(false);
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource | undefined)?.setData(asFeature(geometry));
    if (geometry) fitToLine(map, geometry);
  }, [geometry, loaded]);

  if (failed) return <p className="muted">{t("map.unavailable")}</p>;
  return <div ref={container} className="trail-map" role="region" aria-label={label} />;
}
