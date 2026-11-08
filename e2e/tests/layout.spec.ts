import { mkdirSync } from "node:fs";
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

// A real name can be long, and without a place to break it.
const LONG = "Dolgoimenskapohodniskaskupinabrezpresledkovkijezelodolgaindolgaindolga";

/** Every control a user needs must be on the screen, not cut off past its edge. */
async function expectControlsInsideScreen(page: Page) {
  const outside = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return [...document.querySelectorAll("a, button, input, select, textarea")]
      .filter((element) => {
        if (element.closest(".table-wrap, .trail-map")) return false;
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.left < -1 || box.right > width + 1);
      })
      .map((element) => element.outerHTML.slice(0, 100));
  });
  expect(outside, `controls outside the screen on ${page.url()}`).toEqual([]);
}

test("every page fits the screen, and the main ones are photographed", async ({
  browser,
}, testInfo) => {
  const email = uniqueEmail("layout");
  const me = await ApiClient.as(email, "Sara Novak");
  const friend = await ApiClient.as(uniqueEmail("jan"), "Jan Horvat");
  const outsider = await ApiClient.as(uniqueEmail("edo"), "Edo Kovač");
  const groupName = unique("Planinke");
  const group = await me.createGroup(groupName, "public");
  await me.addMember(group.id, friend);
  await me.post(`/groups/${group.id}/invitations`, {
    email: uniqueEmail("a-very-long-address-of-someone-invited-here"),
  });
  await outsider.post(`/groups/${group.id}/join-requests`);
  const guest = await me.post<{ id: string }>(`/groups/${group.id}/guests`, { nickname: "Metka" });
  const longGroup = await me.createGroup(`${LONG} ${unique("x")}`);
  const trail = await me.createTrail(unique("Pot na Krn"), 12.5, 1250, {
    visibility: "group",
    group_id: group.id,
  });
  const longTrail = await me.createTrail(`${LONG}${unique("y")}`, 1234.5, 12345, {
    description: `${LONG}${LONG}`,
  });
  const imported = await me.post("/trails/osm/import", {
    relation_id: 19446684,
    visibility: "private",
  });
  await me.createHike({
    trail_id: trail.id,
    start_at: "2026-03-16T09:05:00+01:00",
    duration_s: 12600,
    group_id: group.id,
    attendee_user_ids: [me.id, friend.id],
    attendee_guest_ids: [guest.id],
    notes: `${LONG}${LONG}`,
  } as never);
  await me.createHike({
    trail_id: longTrail.id,
    start_at: "2026-03-17T09:05:00+01:00",
    duration_s: 360000,
  });
  const publicGroup = await friend.createGroup(unique("Javni"), "public");
  const invited = uniqueEmail("povabljena");
  await me.post(`/groups/${group.id}/invitations`, { email: invited });
  const invitation = await invitationFromMail(invited);

  const pages: [string, string][] = [
    ["home", "/"],
    ["trails", "/trails"],
    ["trail-new", "/trails/new"],
    ["trail-manual", `/trails/${trail.id}`],
    ["trail-osm", `/trails/${imported.id}`],
    ["trail-long-name", `/trails/${longTrail.id}`],
    ["trail-edit", `/trails/${trail.id}/edit`],
    ["osm-import", "/trails/import"],
    ["hikes", "/hikes"],
    ["hike-new", "/hikes/new"],
    ["hike-new-group", `/hikes/new?group=${group.id}`],
    ["hikes-group", `/hikes?group=${group.id}`],
    ["groups", "/groups"],
    ["group-new", "/groups/new"],
    ["group-admin", `/groups/${group.id}`],
    ["group-long-name", `/groups/${longGroup.id}`],
    ["group-outside", `/groups/${publicGroup.id}`],
    ["stats", "/stats"],
    ["stats-group", `/stats?group=${group.id}`],
    ["profile", "/profile"],
  ];
  const { page, problems } = await signedInPage(browser, email);
  const directory = `screenshots/${testInfo.project.name}`;
  mkdirSync(directory, { recursive: true });

  for (const [name, path] of pages) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".site-main")).not.toBeEmpty();
    await expectNoHorizontalScroll(page);
    await expectControlsInsideScreen(page);
    await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
  }

  // Slovenian words are longer.
  await page.locator("header").getByRole("combobox").selectOption("sl");
  for (const [name, path] of pages) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expectNoHorizontalScroll(page);
    await expectControlsInsideScreen(page);
    if (["home", "group-admin", "stats-group"].includes(name)) {
      await page.screenshot({ path: `${directory}/${name}-sl.png`, fullPage: true });
    }
  }

  const invitedPage = await signedInPage(browser, invited);
  await invitedPage.page.goto(invitation.path);
  await expect(invitedPage.page.getByRole("button", { name: "Accept" })).toBeVisible();
  await expectNoHorizontalScroll(invitedPage.page);
  await invitedPage.page.screenshot({ path: `${directory}/invitation.png`, fullPage: true });

  // The sign-in page.
  const visitor = await browser.newContext();
  const login = await visitor.newPage();
  await login.goto("/login");
  await expect(login.locator("hanko-auth")).toBeAttached();
  await expectNoHorizontalScroll(login);
  await login.screenshot({ path: `${directory}/login.png`, fullPage: true });

  expect(problems).toEqual([]);
  expect(invitedPage.problems).toEqual([]);
});

test("a wide table scrolls inside its own frame on a phone, not the whole page", async ({
  browser,
}) => {
  const email = uniqueEmail("table");
  const me = await ApiClient.as(email, "Sara Novak");
  const group = await me.createGroup(unique("Table"));
  const trail = await me.createTrail(unique("Table trail"), 1234.5, 12345, {
    visibility: "group",
    group_id: group.id,
  });
  await me.createHike({
    trail_id: trail.id,
    start_at: "2026-03-16T09:05:00+01:00",
    duration_s: 360000,
    group_id: group.id,
    attendee_user_ids: [me.id],
  });
  const { page, problems } = await signedInPage(browser, email);
  await page.goto(`/stats?group=${group.id}`);
  // The breakdown by attendee, and the best times by trail.
  const tables = page.getByRole("table");
  await expect(tables).toHaveCount(2);
  await expectNoHorizontalScroll(page);
  for (const [index, last, duration] of [
    [0, "Average", page.getByRole("table").nth(0).getByRole("cell").last()],
    [1, "On", page.getByRole("table").nth(1).getByRole("cell").nth(2)],
  ] as const) {
    const table = tables.nth(index);
    // Reachable by scrolling the frame: the last column can be brought into view.
    const lastHeader = table.getByRole("columnheader", { name: last, exact: true });
    await lastHeader.scrollIntoViewIfNeeded();
    await expect(lastHeader).toBeInViewport();
    // A duration with its units stays on one line, rather than one word per line.
    await expect(duration).toHaveText("100 hr");
    const lineHeight = await duration.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    });
    expect(lineHeight).toBe(1);
  }
  expect(problems).toEqual([]);
});
