import { expect, expectNoHorizontalScroll, signedInPage, test, uniqueEmail } from "./helpers";

test("a visitor is sent to sign-in", async ({ page }) => {
  await page.goto("/trails");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("hanko-auth")).toBeAttached();
});

test("first sign-in creates the account, and the profile can be edited", async ({ browser }) => {
  const email = uniqueEmail("marko");
  const { page, problems } = await signedInPage(browser, email);

  await page.goto("/profile");
  await expect(page.getByLabel("E-mail")).toHaveValue(email);
  await expect(page.getByLabel("E-mail")).toBeDisabled();
  await expectNoHorizontalScroll(page);

  await page.getByLabel("Name or nickname").fill("Marko V");
  await page.getByLabel("Country").selectOption("SI");
  await page.getByLabel("City").fill("Ljubljana");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Name or nickname")).toHaveValue("Marko V");
  await expect(page.getByLabel("Country")).toHaveValue("SI");
  await expect(page.getByLabel("City")).toHaveValue("Ljubljana");
  expect(problems).toEqual([]);
});

test("the chosen language follows the user to another device", async ({ browser }) => {
  const email = uniqueEmail("language");
  const first = await signedInPage(browser, email);
  await first.page.goto("/profile");
  await first.page.getByRole("combobox", { name: "Language" }).selectOption("sl");
  await expect(first.page.getByRole("heading", { name: "Profil" })).toBeVisible();
  await expect(first.page.locator("html")).toHaveAttribute("lang", "sl");
  // Give the save a moment to reach the server before opening the second device.
  await first.page.waitForResponse((r) => r.url().endsWith("/api/me")).catch(() => undefined);

  const second = await signedInPage(browser, email, { locale: "en-US" });
  await second.page.goto("/profile");
  await expect(second.page.getByRole("heading", { name: "Profil" })).toBeVisible();
  expect(first.problems).toEqual([]);
  expect(second.problems).toEqual([]);
});

test("a Slovenian browser gets Slovenian, also stored at first sign-in", async ({ browser }) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("sl"), { locale: "sl-SI" });

  await page.goto("/profile");

  await expect(page.getByRole("heading", { name: "Profil" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Poti" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("signing out returns to sign-in and stays signed out", async ({ browser }) => {
  const { page } = await signedInPage(browser, uniqueEmail("logout"));
  await page.goto("/profile");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/profile");
  await expect(page).toHaveURL(/\/login$/);
});

test("an expired session leads to sign-in, not to a broken page", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const expired = await import("./helpers").then((h) => h.tokenFor(uniqueEmail("old"), -60));
  await context.addCookies([{ name: "hanko", value: expired, domain: "localhost", path: "/" }]);
  const page = await context.newPage();

  await page.goto("/profile");

  await expect(page).toHaveURL(/\/login$/);
});

test("the API rejects requests without a token", async ({ request }) => {
  expect((await request.get("/api/me")).status()).toBe(401);
});

test("the app is an installable PWA", async ({ request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.name).toBe("TrailStat");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(
    expect.arrayContaining(["192x192", "512x512"]),
  );
  expect((await request.get("/sw.js")).status()).toBe(200);
});
