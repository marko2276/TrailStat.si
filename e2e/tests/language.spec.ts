import { readdirSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  ApiClient,
  expect,
  expectNoHorizontalScroll,
  invitationFromMail,
  signedInPage,
  test,
  unique,
  uniqueEmail,
} from "./helpers";

const LOCALES = process.env.E2E_LOCALES ?? "/locales";

function flatten(value: unknown, path: string, into: Map<string, string>) {
  if (typeof value === "string") into.set(path, value);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) flatten(child, `${path}.${key}`, into);
  }
}

function strings(language: string): Map<string, string> {
  const all = new Map<string, string>();
  for (const file of readdirSync(`${LOCALES}/${language}`)) {
    const namespace = file.replace(".json", "");
    flatten(JSON.parse(readFileSync(`${LOCALES}/${language}/${file}`, "utf8")), namespace, all);
  }
  return all;
}

/**
 * The parts of English strings that must never be visible in Slovenian. A part must be a phrase:
 * single short words such as "Group" could be the name of something a user created.
 */
function englishPhrases(): string[] {
  const english = strings("en");
  const slovene = new Set(strings("sl").values());
  const phrases = new Set<string>();
  for (const value of english.values()) {
    if (slovene.has(value)) continue;
    for (const part of value.split(/\{\{.*?\}\}/)) {
      const phrase = part.trim();
      if (phrase.length >= 4 && /[a-z]{3}/i.test(phrase)) phrases.add(phrase);
    }
  }
  // Names that stay the same in both languages.
  for (const same of ["TrailStat", "Slovenian", "English", "OpenStreetMap"]) phrases.delete(same);
  return [...phrases];
}

const ENGLISH = englishPhrases();
const RAW_KEY =
  /\b(?:common|errors|groups|hikes|profile|stats|trails|list|fields|actions|osm|chart|map)[.:][a-zA-Z_]+\b/;

/** Everything a reader, including one using a screen reader, can get from the page. */
async function everyText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts = [document.body.innerText, document.title];
    for (const element of document.querySelectorAll("*")) {
      for (const name of ["aria-label", "placeholder", "title", "alt"]) {
        const value = element.getAttribute(name);
        if (value) parts.push(value);
      }
    }
    for (const option of document.querySelectorAll("option")) parts.push(option.text);
    return parts.join("\n");
  });
}

/** What other tests named: all users see public trails and groups, in any language. */
async function publicNames(api: ApiClient): Promise<string[]> {
  const trails = await api.get<{ items: { name: string }[] }>("/trails?scope=public&limit=200");
  const groups = await api.get<{ items: { name: string }[] }>("/groups?scope=public&limit=200");
  return [...trails.items, ...groups.items].map((item) => item.name);
}

async function expectAllSlovenian(page: Page, api: ApiClient) {
  await expect(page.locator("html")).toHaveAttribute("lang", "sl");
  let text = await everyText(page);
  for (const name of await publicNames(api)) text = text.replaceAll(name, "");
  expect(text, `raw translation key on ${page.url()}`).not.toMatch(RAW_KEY);
  // Whole words only, or "Trail" would be found in "TrailStat".
  const leftovers = ENGLISH.filter((phrase) =>
    new RegExp(`(^|[^\\p{L}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(
      text,
    ),
  );
  expect(leftovers, `English on ${page.url()}`).toEqual([]);
}

test("every main page reads correctly in Slovenian", async ({ browser }) => {
  const email = uniqueEmail("sara");
  const me = await ApiClient.as(email, "Sara", "sl");
  const friend = await ApiClient.as(uniqueEmail("jan"), "Jan", "sl");
  const groupName = unique("Planinke");
  const group = await me.createGroup(groupName);
  await me.addMember(group.id, friend);
  const guest = await me.post<{ id: string }>(`/groups/${group.id}/guests`, { nickname: "Metka" });
  const trailName = unique("Pot na Krn");
  const trail = await me.createTrail(trailName, 12.5, 1250, {
    visibility: "group",
    group_id: group.id,
  });
  const otherTrail = await me.createTrail(unique("Moja pot"), 3, 40);
  await me.post(`/groups/${group.id}/invitations`, { email: uniqueEmail("povabljen") });
  const publicGroup = await friend.createGroup(unique("Javni"), "public");
  const invited = uniqueEmail("povabljena");
  const invitedApi = await ApiClient.as(invited, "Povabljena", "sl");
  await me.post(`/groups/${group.id}/invitations`, { email: invited });
  const invitation = await invitationFromMail(invited);
  expect(invitation.text).toContain("Povezava velja 7 dni.");

  await me.createHike({
    trail_id: trail.id,
    start_at: "2026-03-16T09:05:00+01:00",
    duration_s: 12600,
    group_id: group.id,
    attendee_user_ids: [me.id, friend.id],
    attendee_guest_ids: [guest.id],
  });

  const { page, problems } = await signedInPage(browser, email, { locale: "en-US" });
  // The profile's language wins over the browser's, here English.
  const pages = [
    "/",
    "/trails",
    "/trails/new",
    `/trails/${trail.id}`,
    `/trails/${trail.id}/edit`,
    "/trails/import",
    "/hikes",
    "/hikes/new",
    `/hikes/new?group=${group.id}`,
    `/hikes?group=${group.id}`,
    "/groups",
    "/groups/new",
    `/groups/${group.id}`,
    `/groups/${publicGroup.id}`,
    "/stats",
    `/stats?group=${group.id}`,
    "/profile",
  ];
  for (const path of pages) {
    await page.goto(path);
    await expect(page.locator(".site-main")).not.toContainText("Nalaganje", { timeout: 10_000 });
    await expect(page.locator("header nav").getByRole("link", { name: "Poti" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expectAllSlovenian(page, me);
    await expectNoHorizontalScroll(page);
  }

  await expect(page.locator("header nav")).toHaveAttribute("aria-label", "Glavna navigacija");

  // Numbers, dates and durations in Slovenian format.
  await page.goto("/trails/" + trail.id);
  await expect(page.getByText("12,5 km")).toBeVisible();
  await expect(page.getByText("1.250 m")).toBeVisible();
  await page.goto("/stats");
  const value = (label: string) =>
    page.locator("dl.stat-grid > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
  await expect(value("Skupna razdalja")).toHaveText(/^12,5\skm$/);
  await expect(value("Skupni vzpon")).toHaveText(/^1\.250\sm$/);
  await expect(value("Skupni čas")).toHaveText(/^3\sh\s30\smin$/);
  await page.goto("/hikes");
  const card = page.locator("article").first();
  await expect(card).toContainText(/16\.\s?mar\.\s?2026,?\s09:05/);
  await expect(card).toContainText("Udeleženci: ");

  // The month names of the period picker.
  await page.goto("/stats");
  await page.getByLabel("Obdobje").selectOption("month");
  await expect(page.locator("#period-month option").first()).toHaveText("januar");
  await expectAllSlovenian(page, me);

  // Plural forms: 1 pohod, 2 pohoda, 3 pohodi, 4 pohodi, 5 pohodov.
  await page.goto("/hikes");
  await expect(page.getByText("1 pohod", { exact: true })).toBeVisible();
  const expected = [
    [2, "2 pohoda"],
    [3, "3 pohodi"],
    [4, "4 pohodi"],
    [5, "5 pohodov"],
  ] as const;
  for (const [count, text] of expected) {
    await me.createHike({
      trail_id: otherTrail.id,
      start_at: `2026-04-${String(count).padStart(2, "0")}T09:00:00+02:00`,
      duration_s: 3600,
    });
    await page.goto("/hikes");
    await expect(page.getByText(text, { exact: true }), `for ${count} hikes`).toBeVisible();
  }

  // Reload stays Slovenian, also on a fresh visit to another page.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Moji pohodi" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "sl");

  // Errors from the backend are translated.
  await page.goto("/trails/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("alert")).not.toContainText(/does not exist|not_found/);
  await expectAllSlovenian(page, me);
  await page.goto("/groups/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("alert")).not.toContainText(/does not exist|not_found/);
  await expectAllSlovenian(page, me);
  await page.goto("/no/such/page");
  await expectAllSlovenian(page, me);

  // An invitation in Slovenian.
  const invitedPage = await signedInPage(browser, invitedApi.email);
  await invitedPage.page.goto(invitation.path);
  await expect(invitedPage.page.getByRole("button", { name: "Sprejmi" })).toBeVisible();
  await expectAllSlovenian(invitedPage.page, me);

  expect(problems).toEqual([]);
  expect(invitedPage.problems).toEqual([]);
});

test("the language can be switched on any page, and stays after a reload", async ({ browser }) => {
  const email = uniqueEmail("switch");
  const me = await ApiClient.as(email, "Sara", "en");
  const trail = await me.createTrail(unique("Switch trail"), 12.5, 1250);
  const group = await me.createGroup(unique("Switch group"));
  await me.createHike({
    trail_id: trail.id,
    start_at: "2026-03-16T09:05:00+01:00",
    duration_s: 3600,
  });
  const { page, problems } = await signedInPage(browser, email);

  const pages: [string, string, string][] = [
    ["/", "Statistics", "Statistika"],
    ["/trails", "Create manually", "Ustvari ročno"],
    [`/trails/${trail.id}`, "12.5 km", "12,5 km"],
    ["/hikes", "My hikes", "Moji pohodi"],
    ["/groups", "Create group", "Ustvari skupino"],
    [`/groups/${group.id}`, "Leave group", "Zapusti skupino"],
    ["/stats", "Period", "Obdobje"],
    ["/profile", "Name or nickname", "Ime ali vzdevek"],
  ];
  for (const [path, english, slovene] of pages) {
    await page.goto(path);
    const language = page.locator("header").getByRole("combobox");
    await expect(page.getByText(english, { exact: true }).first()).toBeVisible();
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/api/me") && response.request().method() === "PATCH",
    );
    await language.selectOption("sl");
    await saved;
    await expect(page.getByText(slovene, { exact: true }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "sl");
    await page.reload();
    await expect(page.getByText(slovene, { exact: true }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "sl");

    const back = page.waitForResponse(
      (response) => response.url().endsWith("/api/me") && response.request().method() === "PATCH",
    );
    await page.locator("header").getByRole("combobox").selectOption("en");
    await back;
    await expect(page.getByText(english, { exact: true }).first()).toBeVisible();
  }
  expect(problems).toEqual([]);
});

test("the sign-in page is translated before signing in", async ({ browser }) => {
  const context = await browser.newContext({ locale: "sl-SI" });
  const page = await context.newPage();
  await page.goto("/trails");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("hanko-auth")).toBeAttached();
  await expect(page.locator("html")).toHaveAttribute("lang", "sl");
  await expect(page.getByRole("combobox")).toHaveValue("sl");
  await expect(page.getByText("Beležite svoje pohode", { exact: false })).toBeVisible();
});
