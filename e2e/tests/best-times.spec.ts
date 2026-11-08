import {
  ApiClient,
  expect,
  expectNoHorizontalScroll,
  nav,
  signedInPage,
  test,
  uniqueEmail,
} from "./helpers";

test("the statistics show the fastest hike on each trail, for the chosen period", async ({
  browser,
}) => {
  const email = uniqueEmail("best");
  const me = await ApiClient.as(email, "Ana");
  const krim = await me.createTrail("Krim", 12, 700);
  const triglav = await me.createTrail("Triglav", 20, 1800);
  await me.createHike({ trail_id: krim.id, start_at: "2025-04-05T07:00:00Z", duration_s: 10_800 });
  // The fastest on Krim: 2 h 30 min, on 2 May 2026.
  await me.createHike({ trail_id: krim.id, start_at: "2026-05-02T07:00:00Z", duration_s: 9_000 });
  await me.createHike({ trail_id: krim.id, start_at: "2026-06-07T07:00:00Z", duration_s: 9_600 });
  await me.createHike({ trail_id: triglav.id, start_at: "2026-08-15T04:00:00Z", duration_s: 30_600 });

  const { page, problems } = await signedInPage(browser, email);
  await page.goto("/");
  await nav(page, "Statistics");

  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Best times by trail" }),
  });
  const rows = section.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  // Most hiked first.
  await expect(rows.nth(0)).toContainText("Krim");
  await expect(rows.nth(0).locator("td").nth(1)).toHaveText("3");
  await expect(rows.nth(0).locator("td").nth(2)).toHaveText(/^2\D+30\D+$/);
  await expect(rows.nth(0).locator("td").nth(3)).toHaveText("May 2, 2026");
  await expect(rows.nth(1)).toContainText("Triglav");
  await expectNoHorizontalScroll(page);

  // In 2025 the only hike on Krim was slower, and there was none on Triglav.
  await page.getByLabel("Period").selectOption("year");
  await page.getByLabel("Year").fill("2025");
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).locator("td").nth(2)).toHaveText(/^3\D+$/);

  await page.getByLabel("Period").selectOption("all");
  await rows.nth(0).getByRole("link", { name: "Krim" }).click();
  await expect(page.getByRole("heading", { name: "Krim", level: 1 })).toBeVisible();
  expect(problems).toEqual([]);
});
