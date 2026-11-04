import { expect, test as base } from "@playwright/test";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";

const appPort = process.env.E2E_APP_PORT ?? "18080";
const hankoPort = process.env.E2E_HANKO_PORT ?? "14000";
const mailpitPort = process.env.E2E_MAILPIT_PORT ?? "18025";

export const TIME_ZONE = "Europe/Ljubljana";

export function uniqueEmail(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Names of public things are unique across all users, and tests share one database. */
export function unique(name: string): string {
  return `${name} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function tokenFor(email: string, expiresIn?: number): Promise<string> {
  const response = await fetch(`http://localhost:${hankoPort}/test/token`, {
    method: "POST",
    body: JSON.stringify({ email, expiresIn }),
  });
  return ((await response.json()) as { token: string }).token;
}

/** Tests must not depend on the real tile server: the map gets an empty style instead. */
export async function stubMapStyle(context: BrowserContext) {
  await context.route("https://tiles.openfreemap.org/**", (route) =>
    route.fulfill({
      json: { version: 8, sources: {}, layers: [] },
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
}

export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    // Expected HTTP errors show up in the console. Their handling is asserted in the tests.
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      problems.push(`console: ${message.text()}`);
    }
  });
  return problems;
}

/** A browser session signed in as this e-mail, failing the test on any browser error. */
export async function signedInPage(
  browser: Browser,
  email: string,
  options: { locale?: string } = {},
): Promise<{ page: Page; context: BrowserContext; problems: string[] }> {
  const context = await browser.newContext({
    locale: options.locale ?? "en-US",
    timezoneId: TIME_ZONE,
  });
  await stubMapStyle(context);
  await context.addCookies([
    { name: "hanko", value: await tokenFor(email), domain: "localhost", path: "/" },
  ]);
  const page = await context.newPage();
  return { page, context, problems: watchProblems(page) };
}

export { expect, base as test };

/** The page must not scroll sideways: the body has to fit the screen. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${page.url()} scrolls horizontally`).toBeLessThanOrEqual(1);
}

/** Calls the API directly as a user, to arrange what a test isn't about, or to check a refusal. */
export class ApiClient {
  private constructor(
    readonly email: string,
    private readonly token: string,
    readonly id: string,
  ) {}

  static async as(email: string, displayName?: string, locale = "en"): Promise<ApiClient> {
    const token = await tokenFor(email);
    const me = await new ApiClient(email, token, "").call("PATCH", "/me", {
      locale,
      ...(displayName ? { display_name: displayName } : {}),
    });
    return new ApiClient(email, token, ((await me.json()) as { id: string }).id);
  }

  call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`http://localhost:${appPort}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.call(method, path, body);
    if (!response.ok) {
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  get<T = Record<string, unknown>>(path: string) {
    return this.ok<T>("GET", path);
  }

  post<T = { id: string }>(path: string, body?: unknown) {
    return this.ok<T>("POST", path, body);
  }

  createTrail(name: string, km: number, gain: number, sharing: Record<string, unknown> = {}) {
    return this.post("/trails", {
      name,
      distance_m: Math.round(km * 1000),
      elevation_gain_m: gain,
      visibility: "private",
      ...sharing,
    });
  }

  createGroup(name: string, visibility: "public" | "private" = "private") {
    return this.post("/groups", { name, description: `About ${name}`, visibility });
  }

  /** Invites this user by e-mail, and accepts as the other. */
  async addMember(groupId: string, member: ApiClient) {
    await this.post(`/groups/${groupId}/invitations`, { email: member.email });
    const { token } = await invitationFromMail(member.email);
    await member.post(`/groups/invitations/${token}/accept`);
  }

  createHike(hike: {
    trail_id: string;
    start_at: string;
    duration_s: number;
    group_id?: string;
    attendee_user_ids?: string[];
    attendee_guest_ids?: string[];
  }) {
    return this.post("/hikes", hike);
  }
}

export interface Mail {
  subject: string;
  text: string;
  to: string;
}

/** The newest e-mail to this address, waiting for it to arrive. */
export async function waitForMail(to: string, subject?: RegExp): Promise<Mail> {
  const base = `http://localhost:${mailpitPort}/api/v1`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const search = await fetch(`${base}/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = (await search.json()) as {
      messages: { ID: string; Subject: string }[];
    };
    const found = messages.find((message) => !subject || subject.test(message.Subject));
    if (found) {
      const message = (await (await fetch(`${base}/message/${found.ID}`)).json()) as {
        Subject: string;
        Text: string;
      };
      return { subject: message.Subject, text: message.Text, to };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No e-mail to ${to} arrived`);
}

/** The invitation link in the real e-mail, with the path the app is opened at. */
export async function invitationFromMail(
  to: string,
): Promise<Mail & { link: string; path: string; token: string }> {
  const mail = await waitForMail(to);
  const link = /https?:\/\/\S+\/invitations\/\S+/.exec(mail.text)?.[0];
  if (!link) throw new Error(`No invitation link in: ${mail.text}`);
  const url = new URL(link);
  expect(url.port, "the link points at the app").toBe(appPort);
  return { ...mail, link, path: url.pathname, token: url.pathname.split("/").pop()! };
}

// Finding things on pages

export function nav(page: Page, name: string): Promise<void> {
  return page.locator("header nav").getByRole("link", { name, exact: true }).click();
}

/** The value of a statistic's tile, by its exact label. */
export function tile(page: Page, label: string): Locator {
  return page
    .locator("dl.stat-grid > div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");
}

export interface Totals {
  hikes: string;
  distance: string;
  elevation: string;
  time: string;
  average: string;
}

/** The statistics tiles, in English. */
export async function expectTotals(page: Page, totals: Totals) {
  await expect(tile(page, "Hikes")).toHaveText(totals.hikes);
  await expect(tile(page, "Total distance")).toHaveText(totals.distance);
  await expect(tile(page, "Total elevation gain")).toHaveText(totals.elevation);
  await expect(tile(page, "Total time")).toHaveText(totals.time);
  await expect(tile(page, "Average time")).toHaveText(totals.average);
}

export const NO_HIKES: Totals = {
  hikes: "0",
  distance: "0 km",
  elevation: "0 m",
  time: "0 min",
  average: "0 min",
};

export function hikeCard(page: Page, trailName: string): Locator {
  return page.locator("article").filter({ has: page.getByRole("heading", { name: trailName }) });
}

// Doing things through the pages

export async function createTrailInUi(
  page: Page,
  trail: { name: string; km: string; gain: string; visibility?: string; group?: string },
) {
  await page.getByLabel("Name", { exact: true }).fill(trail.name);
  await page.getByLabel("Distance (km)").fill(trail.km);
  await page.getByLabel("Elevation gain (m)").fill(trail.gain);
  if (trail.visibility) await page.getByLabel("Who can see it").selectOption(trail.visibility);
  if (trail.group) await page.getByLabel("Group", { exact: true }).selectOption({ label: trail.group });
  await page.getByRole("button", { name: "Create trail" }).click();
}

export async function chooseTrail(page: Page, name: string) {
  await page.getByLabel("Search trails").fill(name);
  await page.getByRole("button", { name }).click();
}

/** Fills the fields of the hike form that every hike has, then saves unless told otherwise. */
export async function fillHike(
  page: Page,
  hike: { trail?: string; date: string; time: string; hours: string; minutes: string },
) {
  if (hike.trail) await chooseTrail(page, hike.trail);
  await page.getByLabel("Date").fill(hike.date);
  await page.getByLabel("Start time").fill(hike.time);
  await page.getByLabel("Hours").fill(hike.hours);
  await page.getByLabel("Minutes").fill(hike.minutes);
}

/** Selects a period on the statistics page. */
export async function choosePeriod(
  page: Page,
  period: { kind: "all" | "day" | "month" | "year"; date?: string; month?: string; year?: string },
) {
  await page.getByLabel("Period").selectOption(period.kind);
  if (period.date) await page.locator("#period-date").fill(period.date);
  if (period.year) await page.getByLabel("Year").fill(period.year);
  if (period.month) await page.locator("#period-month").selectOption({ label: period.month });
}
