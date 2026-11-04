import { expect, test as base } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const hankoPort = process.env.E2E_HANKO_PORT ?? "14000";

export function uniqueEmail(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export async function tokenFor(email: string, expiresIn?: number): Promise<string> {
  const response = await fetch(`http://localhost:${hankoPort}/test/token`, {
    method: "POST",
    body: JSON.stringify({ email, expiresIn }),
  });
  return ((await response.json()) as { token: string }).token;
}

/** A browser session signed in as this e-mail, failing the test on any browser error. */
export async function signedInPage(
  browser: Browser,
  email: string,
  options: { locale?: string } = {},
): Promise<{ page: Page; context: BrowserContext; problems: string[] }> {
  const context = await browser.newContext({ locale: options.locale ?? "en-US" });
  await context.addCookies([
    { name: "hanko", value: await tokenFor(email), domain: "localhost", path: "/" },
  ]);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    // Expected HTTP errors show up in the console. Their handling is asserted in the tests.
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      problems.push(`console: ${message.text()}`);
    }
  });
  return { page, context, problems };
}

export { expect, base as test };

/** The page must not scroll sideways: the body has to fit the screen. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "page scrolls horizontally").toBeLessThanOrEqual(1);
}
