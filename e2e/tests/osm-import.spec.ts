import {
  ApiClient,
  expect,
  expectNoHorizontalScroll,
  expectTotals,
  fillHike,
  hikeCard,
  nav,
  signedInPage,
  test,
  uniqueEmail,
} from "./helpers";

const ROUTE = "Aljažev dom - Kredarica - Triglav";

test("searching, previewing and importing a route, then hiking it", async ({ browser }) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("osm"));

  await page.goto("/trails");
  await page.getByRole("link", { name: "Import from OpenStreetMap" }).click();
  await page.getByLabel("Name of the hiking route").fill("kredarica");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results.getByText(ROUTE, { exact: true })).toBeVisible();
  await expect(results.getByText("Aljažev dom v Vratih – Triglav")).toBeVisible();
  await expectNoHorizontalScroll(page);

  await results.getByRole("button", { name: `Preview ${ROUTE}` }).click();
  await expect(page.getByText(/^Distance: \d+(\.\d)? km$/)).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(ROUTE);
  await expect(page.locator(".trail-map canvas")).toBeVisible();
  await expect(page.getByRole("link", { name: /OpenStreetMap contributors \(ODbL\)/ })).toBeVisible();
  const preview = await page.getByText(/^Distance: /).innerText();
  const distance = preview.replace("Distance: ", "");
  await expectNoHorizontalScroll(page);

  await page.getByRole("button", { name: "Import trail" }).click();
  await expect(page.getByRole("heading", { name: ROUTE, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/trails\/[0-9a-f-]{36}$/);

  // Measurements: the distance of the preview, and heights from the synthetic elevation file.
  const value = (label: string) =>
    page.locator(".stat-grid .card").filter({ hasText: label }).locator(".stat-value");
  await expect(value("Distance")).toHaveText(distance);
  await expect(value("Distance")).toHaveText("5.8 km");
  await expect(value("Elevation gain")).toHaveText("1,791 m");
  await expect(value("Elevation loss")).toHaveText("85 m");
  await expect(value("Highest point")).toHaveText("2,835 m");

  await expect(page.locator(".trail-map canvas")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Elevation profile" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Elevation profile" })).toBeVisible();
  await expect(page.locator("#elevation-summary")).toHaveText(
    "Over 5.8 km: starts at 1,038 m and ends at 2,743 m, with a lowest point of 1,038 m and a highest point of 2,835 m.",
  );
  await expect(page.getByText(/Copernicus WorldDEM-30/)).toBeVisible();
  await expect(page.getByRole("link", { name: /OpenStreetMap contributors \(ODbL\)/ })).toBeVisible();
  const osmLink = page.getByRole("link", { name: "View on OpenStreetMap" });
  await expect(osmLink).toHaveAttribute("href", "https://www.openstreetmap.org/relation/19446684");
  await expect(page.getByText("No elevation data")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  const gain = await value("Elevation gain").innerText();

  // An imported trail's measurements can't be edited.
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(ROUTE);
  await expect(page.getByLabel("Distance (km)")).toHaveCount(0);

  // A hike on it counts what the page showed. The trail is new, so the app must already know it.
  await nav(page, "Hikes");
  await page.getByRole("link", { name: "Record a hike" }).click();
  await fillHike(page, {
    trail: ROUTE,
    date: "2026-01-10",
    time: "07:00",
    hours: "6",
    minutes: "0",
  });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(hikeCard(page, ROUTE)).toContainText(distance);
  await expect(hikeCard(page, ROUTE)).toContainText(gain);
  await nav(page, "Statistics");
  await expectTotals(page, {
    hikes: "1",
    distance,
    elevation: gain,
    time: "6 hr",
    average: "6 hr",
  });
  expect(problems).toEqual([]);
});

test("a route outside the elevation data says so, and counts no elevation", async ({ browser }) => {
  const email = uniqueEmail("osm-outside");
  const { page, problems } = await signedInPage(browser, email);
  const name = "E2E route outside elevation data";

  await page.goto("/trails/import");
  await page.getByLabel("Name of the hiking route").fill("outside elevation");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: `Preview ${name}` }).click();
  await page.getByRole("button", { name: "Import trail" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await expect(page.getByRole("note")).toHaveText(/No elevation data is available for this trail/);
  await expect(page.getByRole("img", { name: "Elevation profile" })).toHaveCount(0);
  await expect(page.locator(".trail-map canvas")).toBeVisible();
  await expect(page.getByRole("link", { name: /OpenStreetMap contributors \(ODbL\)/ })).toBeVisible();
  await nav(page, "Trails");
  await expect(page.locator(".trail-list li").filter({ hasText: name })).toContainText(
    "No elevation data",
  );

  const api = await ApiClient.as(email);
  const { items } = await api.get<{ items: { id: string; distance_m: number }[] }>("/trails");
  await api.createHike({
    trail_id: items[0].id,
    start_at: "2026-01-10T07:00:00+01:00",
    duration_s: 3600,
  });
  await page.goto("/stats");
  await expectTotals(page, {
    hikes: "1",
    distance: await page.evaluate(
      (metres) => `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(metres / 1000)} km`,
      items[0].distance_m,
    ),
    elevation: "0 m",
    time: "1 hr",
    average: "1 hr",
  });
  expect(problems).toEqual([]);
});

test("Overpass failing shows a clear error and the page keeps working", async ({ browser }) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("osm-down"));
  const unavailable = /OpenStreetMap search is not available right now/;

  await page.goto("/trails/import");
  const search = page.getByLabel("Name of the hiking route");
  const button = page.getByRole("button", { name: "Search", exact: true });

  // Too short never reaches the server.
  await search.fill("a");
  await button.click();
  await expect(page.getByRole("alert")).toHaveText("Enter at least two characters.");

  await search.fill("overpass-down");
  await button.click();
  await expect(page.getByRole("alert")).toHaveText(unavailable);
  await expectNoHorizontalScroll(page);

  // A search that works, followed by a preview that doesn't.
  await search.fill("failing preview");
  await button.click();
  await page.getByRole("button", { name: "Preview E2E route failing preview" }).click();
  await expect(page.getByRole("alert")).toHaveText(unavailable);
  await expect(page.getByRole("button", { name: "Import trail" })).toHaveCount(0);

  // No results is a different message.
  await search.fill("nothing has this name");
  await button.click();
  await expect(page.getByText("No hiking routes found.")).toBeVisible();
  expect(problems).toEqual([]);
});
