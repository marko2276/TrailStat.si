import { expect, test, watchProblems } from "./helpers";

test("anyone can donate with a UPN QR code from the support page", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const problems = watchProblems(page);

  await page.goto("/privacy");
  await page.getByRole("contentinfo").getByRole("link", { name: "Support TrailStat.si" }).click();
  await expect(page.getByRole("heading", { name: "Support TrailStat.si" })).toBeVisible();
  await expect(page.getByText("SI56 0201 7001 4356 205")).toBeVisible();
  await expect(page.getByText("Planinsko društvo Test")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Send with Flik" })).toBeVisible();
  await expect(page.getByText("041 000 000")).toBeVisible();

  const qr = page.getByRole("img", { name: "UPN QR code for a donation of €10" });
  await expect(qr).toBeVisible();
  await expect.poll(() => qr.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await page.getByRole("radio", { name: "€20" }).check();
  const twenty = page.getByRole("img", { name: "UPN QR code for a donation of €20" });
  await expect(twenty).toHaveAttribute("src", "/api/donations/upn-qr.svg?amount_cents=2000");
  await expect
    .poll(() => twenty.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);

  const image = await page.request.get("/api/donations/upn-qr.svg?amount_cents=2000");
  expect(image.headers()["content-type"]).toBe("image/svg+xml");

  expect(problems).toEqual([]);
  await context.close();
});

test("the support page speaks Slovenian", async ({ browser }) => {
  const context = await browser.newContext({ locale: "sl-SI" });
  const page = await context.newPage();
  await page.goto("/support");
  await expect(page.getByRole("heading", { name: "Podprite TrailStat.si" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^5\s€$/ })).toBeVisible();
  await context.close();
});
