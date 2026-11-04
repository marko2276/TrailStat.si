import {
  choosePeriod,
  createTrailInUi,
  expect,
  expectNoHorizontalScroll,
  expectTotals,
  fillHike,
  hikeCard,
  nav,
  NO_HIKES,
  signedInPage,
  test,
  tile,
  unique,
  uniqueEmail,
} from "./helpers";

test("a solo hiker's hikes add up, through every filter, an edit and a delete", async ({
  browser,
}) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("solo"));
  // Every date below is in the past of this moment, and the dashboard's year is 2026.
  await page.clock.setFixedTime(new Date("2026-05-10T10:00:00+02:00"));
  const first = unique("Solo Velika planina");
  const second = unique("Solo Šmarna gora");

  await page.goto("/");
  await expect(page.getByText("You have no recorded hikes yet.")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Two manual trails.
  await nav(page, "Trails");
  await page.getByRole("link", { name: "Create manually" }).click();
  await createTrailInUi(page, { name: first, km: "12.5", gain: "850" });
  await expect(page.getByRole("heading", { name: first })).toBeVisible();
  await expect(page.getByText("12.5 km")).toBeVisible();
  await expect(page.getByText("850 m")).toBeVisible();
  await expect(page.getByText("entered manually")).toBeVisible();
  await expectNoHorizontalScroll(page);

  await nav(page, "Trails");
  await page.getByRole("link", { name: "Create manually" }).click();
  await createTrailInUi(page, { name: second, km: "8,25", gain: "400" });
  await expect(page.getByRole("heading", { name: second })).toBeVisible();

  // The first hike starts half an hour into the local day, which in UTC is the day before.
  await nav(page, "Hikes");
  await page.getByRole("link", { name: "Record a hike" }).click();
  await fillHike(page, {
    trail: first,
    date: "2026-03-16",
    time: "00:30",
    hours: "3",
    minutes: "30",
  });
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/hikes$/);
  await expect(hikeCard(page, first)).toContainText(/Mar 16, 2026, 12:30\sAM/);
  await expect(hikeCard(page, first)).toContainText("3 hr 30 min");
  await expect(hikeCard(page, first)).toContainText("12.5 km");
  await expect(hikeCard(page, first)).toContainText("850 m");
  await expect(page.getByText("1 hike", { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByRole("link", { name: "Record a hike" }).click();
  await fillHike(page, {
    trail: second,
    date: "2026-04-20",
    time: "14:00",
    hours: "1",
    minutes: "15",
  });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("2 hikes", { exact: true })).toBeVisible();

  // The dashboard.
  await page.locator("a.brand").click();
  await expect(page.getByRole("heading", { name: "This year" })).toBeVisible();
  await expect(tile(page, "Hikes")).toHaveText("2");
  await expect(hikeCard(page, first)).toBeVisible();
  await expect(hikeCard(page, second)).toBeVisible();

  // Statistics, all time.
  await nav(page, "Statistics");
  const both = {
    hikes: "2",
    distance: "20.8 km",
    elevation: "1,250 m",
    time: "4 hr 45 min",
    average: "2 hr 23 min",
  };
  const onlyFirst = {
    hikes: "1",
    distance: "12.5 km",
    elevation: "850 m",
    time: "3 hr 30 min",
    average: "3 hr 30 min",
  };
  const onlySecond = {
    hikes: "1",
    distance: "8.3 km",
    elevation: "400 m",
    time: "1 hr 15 min",
    average: "1 hr 15 min",
  };
  await expectTotals(page, both);
  await expectNoHorizontalScroll(page);

  // Day: the local day counts, not the UTC one.
  await choosePeriod(page, { kind: "day", date: "2026-03-16" });
  await expectTotals(page, onlyFirst);
  await expect(hikeCard(page, first)).toBeVisible();
  await expect(hikeCard(page, second)).toHaveCount(0);
  await choosePeriod(page, { kind: "day", date: "2026-03-15" });
  await expectTotals(page, NO_HIKES);
  await expect(page.getByText("No hikes in this period.")).toBeVisible();
  await choosePeriod(page, { kind: "day", date: "2026-04-20" });
  await expectTotals(page, onlySecond);

  // Month.
  await choosePeriod(page, { kind: "month", year: "2026", month: "March" });
  await expectTotals(page, onlyFirst);
  await choosePeriod(page, { kind: "month", year: "2026", month: "April" });
  await expectTotals(page, onlySecond);
  await expect(hikeCard(page, second)).toBeVisible();
  await choosePeriod(page, { kind: "month", year: "2026", month: "May" });
  await expectTotals(page, NO_HIKES);
  await choosePeriod(page, { kind: "month", year: "2025", month: "March" });
  await expectTotals(page, NO_HIKES);

  // Year.
  await choosePeriod(page, { kind: "year", year: "2026" });
  await expectTotals(page, both);
  await choosePeriod(page, { kind: "year", year: "2025" });
  await expectTotals(page, NO_HIKES);
  await choosePeriod(page, { kind: "all" });
  await expectTotals(page, both);

  // Editing changes the totals, without leaving the app.
  await nav(page, "Hikes");
  await hikeCard(page, first).getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel("Date")).toHaveValue("2026-03-16");
  await expect(page.getByLabel("Start time")).toHaveValue("00:30");
  await expect(page.getByLabel("Hours")).toHaveValue("3");
  await expect(page.getByLabel("Minutes")).toHaveValue("30");
  await page.getByLabel("Hours").fill("5");
  await page.getByLabel("Minutes").fill("0");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(hikeCard(page, first)).toContainText("5 hr");
  await nav(page, "Statistics");
  await expectTotals(page, { ...both, time: "6 hr 15 min", average: "3 hr 8 min" });

  // Moving it to another day moves it between filters.
  await nav(page, "Hikes");
  await hikeCard(page, first).getByRole("link", { name: "Edit" }).click();
  await page.getByLabel("Date").fill("2026-02-01");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(hikeCard(page, first)).toContainText("Feb 1, 2026");
  await nav(page, "Statistics");
  await choosePeriod(page, { kind: "month", year: "2026", month: "March" });
  await expectTotals(page, NO_HIKES);
  await choosePeriod(page, { kind: "month", year: "2026", month: "February" });
  await expect(tile(page, "Hikes")).toHaveText("1");
  await choosePeriod(page, { kind: "all" });

  // Deleting takes it away again.
  await nav(page, "Hikes");
  await hikeCard(page, first).getByRole("button", { name: "Delete" }).click();
  await hikeCard(page, first).getByRole("button", { name: "Confirm" }).click();
  await expect(hikeCard(page, first)).toHaveCount(0);
  await expect(page.getByText("1 hike", { exact: true })).toBeVisible();
  await nav(page, "Statistics");
  await expectTotals(page, onlySecond);
  await page.locator("a.brand").click();
  await expect(tile(page, "Hikes")).toHaveText("1");
  await expect(hikeCard(page, first)).toHaveCount(0);

  expect(problems).toEqual([]);
});

test("the hike form explains what is missing, and refuses the future", async ({ browser }) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("form"));
  const name = unique("Form trail");
  await page.goto("/trails/new");
  await createTrailInUi(page, { name, km: "1", gain: "1" });
  await expect(page.getByRole("heading", { name })).toBeVisible();

  await nav(page, "Hikes");
  await page.getByRole("link", { name: "Record a hike" }).click();
  const save = page.getByRole("button", { name: "Save" });
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("Choose a trail.");
  await fillHike(page, { trail: name, date: "2026-01-10", time: "", hours: "", minutes: "" });
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("Enter the date and start time.");
  await page.getByLabel("Start time").fill("08:00");
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("Enter how long the hike took.");
  await page.getByLabel("Date").fill("2999-01-01");
  await page.getByLabel("Minutes").fill("30");
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("The start can't be in the future.");
  expect(problems).toEqual([]);
});
