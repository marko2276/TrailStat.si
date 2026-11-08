/**
 * Reads a route from a GPX or KML file, in the browser. Only the points are sent to the server:
 * a recording's times, heart rate and other data never leave the device.
 */

/** [longitude, latitude] or [longitude, latitude, height in metres], as GeoJSON orders them. */
export type Position = [number, number] | [number, number, number];

export interface FileRoute {
  /** The route's name in the file, if it has one. */
  name: string | null;
  coordinates: Position[];
}

export type RouteFileProblem = "tooLarge" | "kmz" | "unreadable" | "noRoute";

export class RouteFileError extends Error {
  constructor(readonly problem: RouteFileProblem) {
    super(problem);
    this.name = "RouteFileError";
  }
}

/** Larger than a day's recording at one point a second. */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** The same as the backend's limit. Longer recordings are thinned out evenly. */
export const MAX_POINTS = 100_000;

const MAX_NAME = 200;

function byLocalName(parent: Document | Element, name: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS("*", name));
}

function childText(parent: Element, name: string): string | null {
  const child = Array.from(parent.children).find((element) => element.localName === name);
  const text = child?.textContent?.trim();
  return text ? text : null;
}

/** NaN for a missing or empty value, which `Number` would turn into 0. */
function toNumber(text: string | null | undefined): number {
  return text == null || text.trim() === "" ? NaN : Number(text);
}

function finite(...values: number[]) {
  return values.every((value) => Number.isFinite(value));
}

function inRange(longitude: number, latitude: number) {
  return Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90;
}

function cleanName(name: string | null | undefined): string | null {
  // Control characters would be refused by the server, and a name is one line.
  const clean = (name ?? "")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, MAX_NAME).trim() : null;
}

function readGpx(doc: Document): FileRoute {
  // Tracks are recordings; routes are planned. A file usually has one or the other.
  let points = byLocalName(doc, "trkpt");
  if (points.length === 0) points = byLocalName(doc, "rtept");
  const coordinates: Position[] = [];
  for (const point of points) {
    const longitude = toNumber(point.getAttribute("lon"));
    const latitude = toNumber(point.getAttribute("lat"));
    if (!finite(longitude, latitude) || !inRange(longitude, latitude)) continue;
    const height = toNumber(childText(point, "ele"));
    coordinates.push(finite(height) ? [longitude, latitude, height] : [longitude, latitude]);
  }
  const named = [...byLocalName(doc, "trk"), ...byLocalName(doc, "rte")]
    .map((element) => childText(element, "name"))
    .find(Boolean);
  const metadata = byLocalName(doc, "metadata")[0];
  return { name: cleanName(named ?? (metadata ? childText(metadata, "name") : null)), coordinates };
}

function readKml(doc: Document): FileRoute {
  const coordinates: Position[] = [];
  let lineName: string | null = null;
  // Document order, so lines and tracks follow each other as the file has them.
  const lines = byLocalName(doc, "*").filter(
    (element) => element.localName === "LineString" || element.localName === "Track",
  );
  for (const line of lines) {
    const before = coordinates.length;
    if (line.localName === "LineString") {
      const text = byLocalName(line, "coordinates")[0]?.textContent ?? "";
      for (const tuple of text.trim().split(/\s+/)) {
        const [longitude, latitude, height] = tuple.split(",").map(toNumber);
        if (!finite(longitude, latitude) || !inRange(longitude, latitude)) continue;
        coordinates.push(
          height !== undefined && finite(height)
            ? [longitude, latitude, height]
            : [longitude, latitude],
        );
      }
    } else {
      // gx:Track: "longitude latitude height" in each gx:coord.
      for (const coord of byLocalName(line, "coord")) {
        const [longitude, latitude, height] = (coord.textContent ?? "")
          .trim()
          .split(/\s+/)
          .map(toNumber);
        if (!finite(longitude, latitude) || !inRange(longitude, latitude)) continue;
        coordinates.push(
          height !== undefined && finite(height)
            ? [longitude, latitude, height]
            : [longitude, latitude],
        );
      }
    }
    if (coordinates.length > before && lineName === null) {
      const placemark = findAncestor(line, "Placemark");
      lineName = placemark ? childText(placemark, "name") : null;
    }
  }
  const kmlDocument = byLocalName(doc, "Document")[0];
  const documentName = kmlDocument ? childText(kmlDocument, "name") : null;
  return { name: cleanName(lineName ?? documentName), coordinates };
}

/** By local name, as `closest` would miss elements with a namespace prefix. */
function findAncestor(element: Element, localName: string): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.localName === localName) return parent;
  }
  return null;
}

/**
 * Heights that are all zero mean "no height", as in KML lines drawn on the ground. They would
 * otherwise give a flat trail at sea level.
 */
function withoutZeroHeights(coordinates: Position[]): Position[] {
  const heights = coordinates.filter((point) => point.length === 3);
  if (heights.length > 0 && heights.every((point) => point[2] === 0)) {
    return coordinates.map(([longitude, latitude]) => [longitude, latitude]);
  }
  return coordinates;
}

/** Evenly spaced points, always including the first and last. */
export function thinOut(coordinates: Position[], max = MAX_POINTS): Position[] {
  if (coordinates.length <= max) return coordinates;
  const step = (coordinates.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => coordinates[Math.round(i * step)]);
}

/** Reads a route from the text of a GPX or KML file. */
export function parseRouteText(text: string): FileRoute {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (byLocalName(doc, "parsererror").length > 0) throw new RouteFileError("unreadable");
  const root = doc.documentElement.localName;
  let route: FileRoute;
  if (root === "gpx") route = readGpx(doc);
  else if (root === "kml") route = readKml(doc);
  else throw new RouteFileError("unreadable");

  if (route.coordinates.length < 2) throw new RouteFileError("noRoute");
  return { name: route.name, coordinates: thinOut(withoutZeroHeights(route.coordinates)) };
}

/** Reads a route from a GPX or KML file the user chose. */
export async function readRouteFile(file: File): Promise<FileRoute> {
  if (file.size > MAX_FILE_BYTES) throw new RouteFileError("tooLarge");
  const start = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  // KMZ is a zip archive, which starts with "PK".
  if (start[0] === 0x50 && start[1] === 0x4b) throw new RouteFileError("kmz");
  return parseRouteText(await file.text());
}
