import { expect, signedInPage, test } from "./helpers";

test("pages are served with a Content-Security-Policy that the app keeps to", async ({
  browser,
  request,
}) => {
  const response = await request.get("/");
  const csp = response.headers()["content-security-policy"];
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("http://localhost:14000");
  expect(csp).toContain("https://tiles.openfreemap.org");
  expect(response.headers()["permissions-policy"]).toContain("camera=()");
  const api = await request.get("/api/donations/upn-qr.svg");
  expect(api.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");

  // A violation is reported in the console, which the problem watcher collects.
  const { page, problems, context } = await signedInPage(browser, "csp@example.com");
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  for (const path of ["/", "/trails", "/trails/new", "/stats", "/support", "/profile"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(violations).toEqual([]);
  expect(problems).toEqual([]);

  // An injected script does not run.
  const ran = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "document.body.dataset.injected = 'yes'";
    document.body.append(script);
    return document.body.dataset.injected === "yes";
  });
  expect(ran).toBe(false);
  await context.close();
});
