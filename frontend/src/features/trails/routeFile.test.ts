import { describe, expect, it } from "vitest";
import { parseRouteText, readRouteFile, RouteFileError, thinOut } from "./routeFile";
import type { Position } from "./routeFile";

const gpxTrack = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Watch" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Activity</name><time>2026-06-01T07:00:00Z</time></metadata>
  <trk>
    <name>Krim</name>
    <trkseg>
      <trkpt lat="45.93" lon="14.47"><ele>300.5</ele><time>2026-06-01T07:00:00Z</time></trkpt>
      <trkpt lat="45.94" lon="14.48"><ele>350</ele></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="45.95" lon="14.49"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

function problemOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof RouteFileError ? error.problem : "other";
  }
  return undefined;
}

describe("reading GPX", () => {
  it("joins a track's segments in order, with heights where the file has them", () => {
    expect(parseRouteText(gpxTrack)).toEqual({
      name: "Krim",
      coordinates: [
        [14.47, 45.93, 300.5],
        [14.48, 45.94, 350],
        [14.49, 45.95],
      ],
    });
  });

  it("falls back to a planned route, and to the file's name", () => {
    const gpx = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Plan</name></metadata>
      <rte><rtept lat="46" lon="14"/><rtept lat="46.1" lon="14.1"/></rte></gpx>`;

    expect(parseRouteText(gpx)).toEqual({
      name: "Plan",
      coordinates: [
        [14, 46],
        [14.1, 46.1],
      ],
    });
  });

  it("prefers a track to a route in the same file", () => {
    const gpx = `<gpx><rte><rtept lat="1" lon="1"/><rtept lat="2" lon="2"/></rte>
      <trk><trkseg><trkpt lat="46" lon="14"/><trkpt lat="46.1" lon="14.1"/></trkseg></trk></gpx>`;

    expect(parseRouteText(gpx).coordinates[0]).toEqual([14, 46]);
  });

  it("works without a namespace, and with GPX 1.0", () => {
    const gpx = `<gpx version="1.0" xmlns="http://www.topografix.com/GPX/1/0">
      <trk><trkseg><trkpt lat="46" lon="14"/><trkpt lat="46.1" lon="14.1"/></trkseg></trk></gpx>`;

    expect(parseRouteText(gpx).coordinates).toHaveLength(2);
    expect(parseRouteText(gpx.replace(/ xmlns="[^"]+"/, "")).coordinates).toHaveLength(2);
  });

  it("skips points with missing or impossible positions", () => {
    const gpx = `<gpx><trk><trkseg>
      <trkpt lat="46" lon="14"/><trkpt lat="x" lon="14"/><trkpt lat="95" lon="14"/>
      <trkpt lon="14"/><trkpt lat="" lon="14"/><trkpt lat="46.1" lon="14.1"/></trkseg></trk></gpx>`;

    expect(parseRouteText(gpx).coordinates).toEqual([
      [14, 46],
      [14.1, 46.1],
    ]);
  });

  it("makes a name one clean line, and has none when the file has none", () => {
    const gpx = `<gpx><trk><name>  Na\tKrim\n  in nazaj </name><trkseg>
      <trkpt lat="46" lon="14"/><trkpt lat="46.1" lon="14.1"/></trkseg></trk></gpx>`;

    expect(parseRouteText(gpx).name).toBe("Na Krim in nazaj");
    expect(parseRouteText(gpx.replace(/<name>.*<\/name>/s, "")).name).toBeNull();
  });
});

describe("reading KML", () => {
  const kml = (body: string) =>
    `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"
       xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>Izlet</name>${body}</Document></kml>`;

  it("reads a line with its heights, named after its placemark", () => {
    const text = kml(`<Placemark><name>Grintovec</name><LineString><coordinates>
        14.53,46.35,1200 14.54,46.36,1500
      </coordinates></LineString></Placemark>`);

    expect(parseRouteText(text)).toEqual({
      name: "Grintovec",
      coordinates: [
        [14.53, 46.35, 1200],
        [14.54, 46.36, 1500],
      ],
    });
  });

  it("drops heights that are all zero, as a line drawn on the ground has", () => {
    const text = kml(`<Placemark><LineString><coordinates>14.53,46.35,0 14.54,46.36,0</coordinates>
      </LineString></Placemark>`);

    expect(parseRouteText(text)).toEqual({
      name: "Izlet",
      coordinates: [
        [14.53, 46.35],
        [14.54, 46.36],
      ],
    });
  });

  it("skips tuples with an empty value instead of reading it as 0", () => {
    const text = kml(`<Placemark><LineString><coordinates>
        14.53,46.35 14.54, 14.55,46.37</coordinates></LineString></Placemark>`);

    expect(parseRouteText(text).coordinates).toEqual([
      [14.53, 46.35],
      [14.55, 46.37],
    ]);
  });

  it("reads a recorded gx:Track", () => {
    const text = kml(`<Placemark><gx:Track><when>2026-06-01T07:00:00Z</when>
      <gx:coord>14.53 46.35 1200</gx:coord><gx:coord>14.54 46.36 1210</gx:coord></gx:Track></Placemark>`);

    expect(parseRouteText(text).coordinates).toEqual([
      [14.53, 46.35, 1200],
      [14.54, 46.36, 1210],
    ]);
  });

  it("joins the lines of a MultiGeometry in order", () => {
    const text = kml(`<Placemark><MultiGeometry>
      <LineString><coordinates>14,46 14.1,46.1</coordinates></LineString>
      <LineString><coordinates>14.2,46.2 14.3,46.3</coordinates></LineString>
      </MultiGeometry></Placemark>`);

    expect(parseRouteText(text).coordinates).toHaveLength(4);
    expect(parseRouteText(text).coordinates[3]).toEqual([14.3, 46.3]);
  });

  it("ignores points, which are no route", () => {
    const text = kml(`<Placemark><Point><coordinates>14,46</coordinates></Point></Placemark>`);

    expect(problemOf(() => parseRouteText(text))).toBe("noRoute");
  });
});

describe("files that are no route", () => {
  it.each([
    ["not XML", "hello"],
    ["another XML format", "<html><body/></html>"],
    ["broken XML", "<gpx><trk>"],
  ])("refuses %s", (_, text) => {
    expect(problemOf(() => parseRouteText(text))).toBe("unreadable");
  });

  it("refuses a file with a single point", () => {
    expect(problemOf(() => parseRouteText(`<gpx><wpt lat="46" lon="14"/></gpx>`))).toBe("noRoute");
  });

  it("refuses KMZ, which is a zip archive", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4])], "route.kmz");

    await expect(readRouteFile(file)).rejects.toMatchObject({ problem: "kmz" });
  });

  it("refuses a file that is too large before reading it", async () => {
    const file = new File(["x"], "huge.gpx");
    Object.defineProperty(file, "size", { value: 31 * 1024 * 1024 });

    await expect(readRouteFile(file)).rejects.toMatchObject({ problem: "tooLarge" });
  });

  it("reads a chosen file", async () => {
    const file = new File([gpxTrack], "krim.gpx", { type: "application/gpx+xml" });

    expect((await readRouteFile(file)).coordinates).toHaveLength(3);
  });
});

describe("thinning out a long recording", () => {
  it("keeps the first and last point and spaces the rest evenly", () => {
    const points: Position[] = Array.from({ length: 1001 }, (_, i) => [i, 0]);

    const thinned = thinOut(points, 11);

    expect(thinned.map((point) => point[0])).toEqual([
      0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    ]);
  });

  it("leaves a short route alone", () => {
    const points: Position[] = [
      [0, 0],
      [1, 1],
    ];

    expect(thinOut(points, 11)).toBe(points);
  });
});
