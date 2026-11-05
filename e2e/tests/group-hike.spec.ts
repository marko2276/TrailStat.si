import type { Page } from "@playwright/test";
import {
  ApiClient,
  expect,
  expectNoHorizontalScroll,
  expectTotals,
  fillHike,
  hikeCard,
  NO_HIKES,
  signedInPage,
  test,
  tile,
  unique,
  uniqueEmail,
} from "./helpers";

function breakdownRow(page: Page, name: string) {
  return page.getByRole("table").getByRole("row").filter({ hasText: name });
}

test("a group hike counts once for the group, and only for those who attended", async ({
  browser,
}) => {
  const [aEmail, bEmail, dEmail] = [uniqueEmail("anna"), uniqueEmail("boris"), uniqueEmail("dana")];
  const a = await ApiClient.as(aEmail, "Anna");
  const b = await ApiClient.as(bEmail, "Boris");
  const d = await ApiClient.as(dEmail, "Dana");
  const groupName = unique("Planinci");
  const group = await a.createGroup(groupName);
  await a.addMember(group.id, b);
  await a.addMember(group.id, d);
  const trailName = unique("Group trail");
  await a.createTrail(trailName, 10, 600, { visibility: "group", group_id: group.id });
  const guest = "Gost Jože";

  const bPage = await signedInPage(browser, bEmail);
  const page = bPage.page;

  // Boris records from the group's page, without having attended himself.
  await page.goto(`/groups/${group.id}`);
  await page.getByRole("link", { name: "Group hikes" }).click();
  await expect(page.getByRole("heading", { name: `Hikes of ${groupName}` })).toBeVisible();
  await expect(page.getByText("This group has no recorded hikes yet.")).toBeVisible();
  await page.getByRole("link", { name: "Record a hike" }).click();
  await expect(page.getByLabel("Type of hike")).toHaveValue(group.id);
  await fillHike(page, {
    trail: trailName,
    date: "2026-02-14",
    time: "09:00",
    hours: "2",
    minutes: "0",
  });
  await expect(page.getByLabel("Boris")).toBeChecked();
  await page.getByLabel("Boris").uncheck();
  await page.getByLabel("Anna").check();
  await expect(page.getByLabel("Dana")).not.toBeChecked();
  await page.getByLabel("New guest's nickname").fill(guest);
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(page.getByLabel(new RegExp(guest))).toBeChecked();
  await expect(page.getByLabel("New guest's nickname")).toHaveValue("");
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Save" }).click();

  // Back on the group's list.
  await expect(page).toHaveURL(new RegExp(`/hikes\\?group=${group.id}$`));
  const card = hikeCard(page, trailName);
  await expect(card).toContainText(`Attended by: Anna, ${guest}`);
  await expect(card).toContainText(/Feb 14, 2026, 9:00\sAM/);
  await expect(card).toContainText(groupName);

  // A plain member can edit what they recorded, but not delete it.
  await expect(card.getByRole("link", { name: "Edit" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Delete" })).toHaveCount(0);
  const hikes = await b.get<{ items: { id: string }[] }>(`/groups/${group.id}/hikes`);
  const hikeId = hikes.items[0].id;
  expect((await b.call("DELETE", `/hikes/${hikeId}`)).status).toBe(403);

  // The guest appears in the group, without having an account.
  await page.getByRole("link", { name: "My hikes" }).click();
  await expect(page.getByText("You have no recorded hikes yet.")).toBeVisible();
  await page.locator("header nav").getByRole("link", { name: "Groups" }).click();
  await page.getByRole("link", { name: groupName }).click();
  await expect(
    page.locator('section[aria-labelledby="group-guests"]').getByText(guest),
  ).toBeVisible();

  // Boris didn't attend: nothing in his statistics.
  await page.locator("header nav").getByRole("link", { name: "Statistics" }).click();
  await expectTotals(page, NO_HIKES);

  // The group's statistics.
  const oneHike = {
    hikes: "1",
    distance: "10 km",
    elevation: "600 m",
    time: "2 hr",
    average: "2 hr",
  };
  await page.getByLabel("Show statistics for").selectOption({ label: groupName });
  await expectTotals(page, oneHike);
  await expect(breakdownRow(page, "Anna")).toContainText("10 km");
  await expect(breakdownRow(page, guest)).toContainText("Guest");
  await expect(breakdownRow(page, guest)).toContainText("600 m");
  await expect(breakdownRow(page, "Boris")).toHaveCount(0);
  await expect(breakdownRow(page, "Dana")).toHaveCount(0);
  await expect(hikeCard(page, trailName)).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Anna attended, and Dana didn't.
  const aPage = await signedInPage(browser, aEmail);
  await aPage.page.goto("/stats");
  await expectTotals(aPage.page, oneHike);
  await aPage.page.goto("/hikes");
  await expect(hikeCard(aPage.page, trailName)).toContainText(`Attended by: Anna, ${guest}`);

  const dPage = await signedInPage(browser, dEmail);
  await dPage.page.goto("/stats");
  await expectTotals(dPage.page, NO_HIKES);
  await dPage.page.goto("/hikes");
  await expect(dPage.page.getByText("You have no recorded hikes yet.")).toBeVisible();
  // Dana sees the group's hike, and can neither change nor delete it.
  await dPage.page.goto(`/hikes?group=${group.id}`);
  await expect(hikeCard(dPage.page, trailName)).toBeVisible();
  await expect(hikeCard(dPage.page, trailName).getByRole("link", { name: "Edit" })).toHaveCount(0);
  await expect(hikeCard(dPage.page, trailName).getByRole("button")).toHaveCount(0);
  expect((await d.call("PATCH", `/hikes/${hikeId}`, { duration_s: 60 })).status).toBe(403);
  expect((await d.call("DELETE", `/hikes/${hikeId}`)).status).toBe(403);

  // A second hike with four attendees is still one hike in the totals.
  const guests = await a.get<{ items: { id: string }[] }>(`/groups/${group.id}/guests`);
  await a.createHike({
    trail_id: (await a.get<{ items: { id: string }[] }>(`/trails?q=${encodeURIComponent(trailName)}`))
      .items[0].id,
    start_at: "2026-03-20T10:00:00+01:00",
    duration_s: 3600,
    group_id: group.id,
    attendee_user_ids: [a.id, b.id, d.id],
    attendee_guest_ids: [guests.items[0].id],
  });
  await page.reload();
  await expect(tile(page, "Hikes")).toHaveText("2");
  await expect(tile(page, "Total distance")).toHaveText("20 km");
  await expect(tile(page, "Total elevation gain")).toHaveText("1,200 m");
  await expect(tile(page, "Total time")).toHaveText("3 hr");
  await expect(tile(page, "Average time")).toHaveText("1 hr 30 min");
  await expect(breakdownRow(page, "Anna")).toContainText("3 hr");
  await expect(breakdownRow(page, "Anna").getByRole("cell").first()).toHaveText("2");
  await expect(breakdownRow(page, "Boris").getByRole("cell").first()).toHaveText("1");
  await expect(breakdownRow(page, "Boris")).toContainText("1 hr");
  await expect(breakdownRow(page, "Dana").getByRole("cell").first()).toHaveText("1");
  await expect(breakdownRow(page, guest).getByRole("cell").first()).toHaveText("2");

  // The group's filter applies to the breakdown too.
  await page.getByLabel("Period").selectOption("month");
  await page.getByLabel("Year").fill("2026");
  await page.locator("#period-month").selectOption({ label: "February" });
  await expect(tile(page, "Hikes")).toHaveText("1");
  await expect(breakdownRow(page, "Boris")).toHaveCount(0);

  // An admin can delete: it's gone for everyone.
  await aPage.page.goto(`/hikes?group=${group.id}`);
  const adminCard = aPage.page
    .locator("article")
    .filter({ hasText: "Attended by: Anna, Gost Jože" })
    .filter({ hasText: "Feb 14" });
  await adminCard.getByRole("button", { name: "Delete" }).click();
  await expect(adminCard.getByText(/permanently/)).toBeVisible();
  await adminCard.getByRole("button", { name: "Confirm" }).click();
  await expect(aPage.page.getByText("1 hike", { exact: true })).toBeVisible();
  await aPage.page.locator("header nav").getByRole("link", { name: "Statistics" }).click();
  await expect(tile(aPage.page, "Hikes")).toHaveText("1");
  await expect(tile(aPage.page, "Total time")).toHaveText("1 hr");

  expect(bPage.problems).toEqual([]);
  expect(aPage.problems).toEqual([]);
  expect(dPage.problems).toEqual([]);
});

test("a recorder's new guest and new member show up in the hike form at once", async ({
  browser,
}) => {
  const aEmail = uniqueEmail("anna");
  const a = await ApiClient.as(aEmail, "Anna");
  const b = await ApiClient.as(uniqueEmail("boris"), "Boris");
  const group = await a.createGroup(unique("Fresh"));
  const { page, problems } = await signedInPage(browser, aEmail);

  // The form has loaded the members and guests. The admin then changes them on the group's page.
  await page.goto(`/hikes/new?group=${group.id}`);
  await expect(page.getByLabel("Anna")).toBeVisible();
  await page.locator("header nav").getByRole("link", { name: "Groups" }).click();
  await page.getByRole("link", { name: "Fresh" }).click();
  const guests = page.locator('section[aria-labelledby="group-guests"]');
  await guests.getByLabel("New guest's nickname").fill("Marta");
  await guests.getByRole("button", { name: "Add guest" }).click();
  await expect(guests.getByText("Marta")).toBeVisible();
  await page.locator("header nav").getByRole("link", { name: "Hikes" }).click();
  await page.getByRole("link", { name: "Record a hike" }).click();
  await page.getByLabel("Type of hike").selectOption(group.id);
  await expect(page.getByLabel(/Marta/)).toBeVisible();

  // A member removed on the group's page is no longer offered.
  await a.addMember(group.id, b);
  await page.goto(`/hikes/new?group=${group.id}`);
  await expect(page.getByLabel("Boris")).toBeVisible();
  await page.locator("header nav").getByRole("link", { name: "Groups" }).click();
  await page.getByRole("link", { name: "Fresh" }).click();
  await page
    .locator('section[aria-labelledby="group-members"] li')
    .filter({ hasText: "Boris" })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await page.getByRole("button", { name: "Remove from group" }).click();
  await expect(page.getByText("Members: 1")).toBeVisible();
  await page.locator("header nav").getByRole("link", { name: "Hikes" }).click();
  await page.getByRole("link", { name: "Record a hike" }).click();
  await page.getByLabel("Type of hike").selectOption(group.id);
  await expect(page.getByLabel("Anna")).toBeVisible();
  await expect(page.getByLabel("Boris")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a private trail can't be used for a group hike", async ({ browser }) => {
  const email = uniqueEmail("anna");
  const a = await ApiClient.as(email, "Anna");
  const group = await a.createGroup(unique("Rules"));
  const name = unique("My own trail");
  const trail = await a.createTrail(name, 3, 30);
  const { page, problems } = await signedInPage(browser, email);

  await page.goto(`/hikes/new`);
  await page.getByLabel("Search trails").fill(name);
  await expect(page.getByRole("button", { name })).toBeVisible();
  await page.getByLabel("Type of hike").selectOption(group.id);
  await expect(page.getByRole("button", { name })).toHaveCount(0);
  await expect(page.getByText("No trails found.")).toBeVisible();

  const refused = await a.call("POST", "/hikes", {
    trail_id: trail.id,
    start_at: "2026-01-01T10:00:00+01:00",
    duration_s: 60,
    group_id: group.id,
    attendee_user_ids: [a.id],
  });
  expect(refused.status).toBe(422);
  expect(problems).toEqual([]);
});

test("attendees change, members leave and guests go, and the numbers follow", async ({
  browser,
}) => {
  const aEmail = uniqueEmail("anna");
  const bEmail = uniqueEmail("boris");
  const a = await ApiClient.as(aEmail, "Anna");
  const b = await ApiClient.as(bEmail, "Boris");
  const d = await ApiClient.as(uniqueEmail("dana"), "Dana");
  const groupName = unique("Changing");
  const group = await a.createGroup(groupName);
  await a.addMember(group.id, b);
  await a.addMember(group.id, d);
  const guest = await a.post<{ id: string }>(`/groups/${group.id}/guests`, { nickname: "Metka" });
  const lone = await a.post<{ id: string }>(`/groups/${group.id}/guests`, { nickname: "Sam" });
  const trailName = unique("Changing trail");
  const trail = await a.createTrail(trailName, 10, 600, {
    visibility: "group",
    group_id: group.id,
  });
  const hike = {
    trail_id: trail.id,
    start_at: "2026-02-14T09:00:00+01:00",
    duration_s: 3600,
    group_id: group.id,
  };
  await a.createHike({ ...hike, attendee_user_ids: [a.id, b.id], attendee_guest_ids: [guest.id] });
  await a.createHike({
    ...hike,
    start_at: "2026-02-15T09:00:00+01:00",
    attendee_guest_ids: [lone.id],
  });
  const { page, problems } = await signedInPage(browser, aEmail);

  // An admin adds Dana to a hike.
  await page.goto(`/stats?group=${group.id}`);
  await expect(tile(page, "Hikes")).toHaveText("2");
  await expect(breakdownRow(page, "Dana")).toHaveCount(0);
  const hikes = page.locator("article").filter({ hasText: "Metka" });
  await hikes.getByRole("link", { name: "Edit" }).click();
  await page.getByLabel("Dana").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("article").filter({ hasText: "Metka" })).toContainText(
    "Attended by: Anna, Boris, Dana, Metka",
  );
  await page.locator("header nav").getByRole("link", { name: "Statistics" }).click();
  await page.getByLabel("Show statistics for").selectOption({ label: groupName });
  await expect(breakdownRow(page, "Dana").getByRole("cell").first()).toHaveText("1");

  // Removing Boris from the group keeps his past hike, in his statistics and in the group's.
  await page.locator("header nav").getByRole("link", { name: "Groups" }).click();
  await page.getByRole("link", { name: groupName }).click();
  await page
    .locator('section[aria-labelledby="group-members"] li')
    .filter({ hasText: "Boris" })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await page.getByRole("button", { name: "Remove from group" }).click();
  await expect(page.getByText("Members: 2")).toBeVisible();
  await page.getByRole("link", { name: "Group statistics" }).click();
  await expect(breakdownRow(page, "Boris").getByRole("cell").first()).toHaveText("1");

  const boris = await signedInPage(browser, bEmail);
  await boris.page.goto("/stats");
  await expect(tile(boris.page, "Hikes")).toHaveText("1");
  const card = hikeCard(boris.page, trailName);
  // Boris keeps his own record, but no longer sees the group's details.
  await expect(card).toContainText(trailName);
  await expect(card).not.toContainText(groupName);
  await expect(card).not.toContainText("Metka");
  await expect(card.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveCount(0);

  // On the edit form Boris is offered as a former member, and can't be added to a new hike.
  await page.locator("article").filter({ hasText: "Metka" }).getByRole("link", { name: "Edit" }).click();
  await expect(page.getByLabel(/Boris/)).toBeChecked();
  await expect(page.getByText("(former member)")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.goto(`/hikes/new?group=${group.id}`);
  await expect(page.getByLabel("Anna")).toBeVisible();
  await expect(page.getByLabel(/Boris/)).toHaveCount(0);

  // Removing guests: Metka's attendance goes, and Sam's hike goes with Sam, without a reload.
  await page.locator("header nav").getByRole("link", { name: "Statistics" }).click();
  await page.getByLabel("Show statistics for").selectOption({ label: groupName });
  await expect(tile(page, "Hikes")).toHaveText("2");
  await page.locator("header nav").getByRole("link", { name: "Groups" }).click();
  await page.getByRole("link", { name: groupName }).click();
  const guests = page.locator('section[aria-labelledby="group-guests"]');
  for (const nickname of ["Metka", "Sam"]) {
    await guests.locator("li").filter({ hasText: nickname }).getByRole("button", { name: "Remove" }).click();
    await guests.getByRole("button", { name: "Remove guest" }).click();
    await expect(guests.locator("li").filter({ hasText: nickname })).toHaveCount(0);
  }
  await page.getByRole("link", { name: "Group statistics" }).click();
  await expect(tile(page, "Hikes")).toHaveText("1");
  await expect(breakdownRow(page, "Metka")).toHaveCount(0);
  await expect(breakdownRow(page, "Sam")).toHaveCount(0);
  await expect(page.locator("article")).toContainText("Attended by: Anna, Boris, Dana");

  expect(problems).toEqual([]);
  expect(boris.problems).toEqual([]);
});
