import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, signedInPage, test, tile, uniqueEmail } from "./helpers";

const FILE_FIELD = "Route from a GPX or KML file (optional)";

/**
 * A recording from a watch, due south through the synthetic elevation tile (e2e/dem), where the
 * height rises 55 m per 0.001 degree southwards. Times and heart rate must not reach the server.
 */
function watchRecording(): string {
  const points = Array.from({ length: 41 }, (_, i) => {
    const latitude = (46.415 - i * 0.001).toFixed(3);
    const time = `2026-06-01T07:${String(i).padStart(2, "0")}:00Z`;
    return `<trkpt lat="${latitude}" lon="13.84"><ele>0</ele><time>${time}</time>
      <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>131</gpxtpx:hr>
      </gpxtpx:TrackPointExtension></extensions></trkpt>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Watch" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><name>Vzpon iz ure</name><trkseg>${points.join("")}</trkseg></trk>
</gpx>`;
}

/** Far outside the elevation data, with heights of its own: up 200 m and down 150 m. */
const plannedKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Načrt</name>
  <Placemark><name>Druga pot</name><LineString><coordinates>
    15.000,46.000,400 15.010,46.005,500 15.020,46.000,600 15.030,46.005,450
  </coordinates></LineString></Placemark>
</Document></kml>`;

function chooseFile(page: Page, name: string, text: string) {
  return page.getByLabel(FILE_FIELD).setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(text),
  });
}

/** A figure on a trail's page. */
function figure(page: Page, label: string) {
  return page.locator(".stat-grid .card").filter({ hasText: label }).locator(".stat-value");
}

test("creating a trail from a watch's GPX recording", async ({ browser }) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("gpx"));
  await page.goto("/trails");
  await page.getByRole("link", { name: "Create manually or from a file" }).click();

  const previewRequest = page.waitForRequest((request) =>
    request.url().endsWith("/api/trails/route-preview"),
  );
  await chooseFile(page, "morning.gpx", watchRecording());

  // Only positions leave the browser: no times, no heart rate, and no zero heights.
  const sent = (await previewRequest).postDataJSON() as {
    geometry: { coordinates: number[][] };
  };
  expect(sent.geometry.coordinates).toHaveLength(41);
  expect(sent.geometry.coordinates.every((point) => point.length === 2)).toBe(true);
  expect(JSON.stringify(sent)).not.toMatch(/2026-06|131|hr/);

  const preview = page.locator(".route-preview");
  await expect(preview.getByText("morning.gpx")).toBeVisible();
  await expect(tile(page, "Distance")).toHaveText("4.4 km");
  // 0.04 degrees south at 55 m per 0.001 degree.
  await expect(tile(page, "Elevation gain")).toHaveText(/^2,(19\d|20\d) m$/);
  await expect(tile(page, "Elevation loss")).toHaveText("0 m");
  await expect(preview.locator(".trail-map canvas")).toBeVisible();
  await expect(preview.getByRole("img", { name: "Elevation profile" })).toBeVisible();
  await expect(preview.getByText(/Copernicus WorldDEM-30/)).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Vzpon iz ure");
  await expect(page.getByLabel("Distance (km)")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  const gain = await tile(page, "Elevation gain").innerText();

  await page.getByRole("button", { name: "Create trail" }).click();
  await expect(page.getByRole("heading", { name: "Vzpon iz ure", level: 1 })).toBeVisible();
  await expect(figure(page, "Distance")).toHaveText("4.4 km");
  await expect(figure(page, "Elevation gain")).toHaveText(gain);
  await expect(page.locator(".trail-map canvas")).toBeVisible();
  await expect(page.getByRole("img", { name: "Elevation profile" })).toBeVisible();
  await expect(page.getByText(/Copernicus WorldDEM-30/)).toBeVisible();
  // The base map credits OpenStreetMap; the route itself is not from there.
  await expect(page.getByRole("link", { name: "View on OpenStreetMap" })).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Its measurements come from the route: a new file can replace them, typing cannot.
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel(FILE_FIELD)).toBeVisible();
  await expect(page.getByLabel("Distance (km)")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("loading a KML route into a manual trail, outside the elevation data", async ({
  browser,
}) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("kml"));
  await page.goto("/trails/new");
  await page.getByLabel("Name", { exact: true }).fill("Ročna pot");
  await page.getByLabel("Distance (km)").fill("12");
  await page.getByLabel("Elevation gain (m)").fill("900");
  await page.getByRole("button", { name: "Create trail" }).click();
  await expect(page.getByText(/entered manually, so it has no map/)).toBeVisible();

  await page.getByRole("link", { name: "Edit" }).click();
  await chooseFile(page, "plan.kml", plannedKml);
  await expect(page.locator(".route-preview").getByText("plan.kml")).toBeVisible();
  await expect(tile(page, "Highest point")).toHaveText("600 m");
  await expect(page.getByText("Elevation: from the heights in the file.")).toBeVisible();
  // The trail keeps its own name.
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Ročna pot");
  await expectNoHorizontalScroll(page);

  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Ročna pot", level: 1 })).toBeVisible();
  await expect(figure(page, "Distance")).not.toHaveText("12 km");
  await expect(figure(page, "Highest point")).toHaveText("600 m");
  await expect(figure(page, "Elevation gain")).not.toHaveText("900 m");
  await expect(page.locator(".trail-map canvas")).toBeVisible();
  await expect(page.getByText("Elevation: from the heights in the file.")).toBeVisible();
  await expect(page.getByText(/Copernicus/)).toHaveCount(0);
  await expect(page.getByText(/entered manually/)).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a file that is no route is explained, and nothing is sent", async ({ browser }) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("badfile"));
  let sent = false;
  page.on("request", (request) => {
    if (request.url().endsWith("/route-preview")) sent = true;
  });
  await page.goto("/trails/new");

  await chooseFile(page, "notes.txt", "Just some notes");

  await expect(page.getByRole("alert")).toHaveText("This file could not be read as GPX or KML.");
  await expect(page.getByLabel("Distance (km)")).toBeVisible();
  expect(sent).toBe(false);
  expect(problems).toEqual([]);
});
