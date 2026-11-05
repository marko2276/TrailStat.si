import {
  ApiClient,
  expect,
  expectTotals,
  hikeCard,
  NO_HIKES,
  signedInPage,
  test,
  unique,
  uniqueEmail,
} from "./helpers";

test("deleting a group keeps hikes for attendees, and frees its trails and guests", async ({
  browser,
}) => {
  const [aEmail, bEmail] = [uniqueEmail("anna"), uniqueEmail("boris")];
  const a = await ApiClient.as(aEmail, "Anna");
  const b = await ApiClient.as(bEmail, "Boris");
  const groupName = unique("Kratkotrajni");
  const group = await a.createGroup(groupName);
  await a.addMember(group.id, b);
  const guest = await a.post<{ id: string }>(`/groups/${group.id}/guests`, { nickname: "Gost Ivo" });
  const guestOnly = await a.post<{ id: string }>(`/groups/${group.id}/guests`, { nickname: "Sam" });

  // Boris's trail is shared with the group. Anna's clashes with her own private one.
  const borisTrail = unique("Borisova pot");
  const shared = await b.createTrail(borisTrail, 10, 600, {
    visibility: "group",
    group_id: group.id,
  });
  const annaTrail = unique("Annina pot");
  const annaPrivate = await a.createTrail(annaTrail, 1, 1);
  const annaShared = await a.createTrail(annaTrail, 4, 200, {
    visibility: "group",
    group_id: group.id,
  });

  const groupHike = {
    start_at: "2026-02-14T09:00:00+01:00",
    duration_s: 7200,
    group_id: group.id,
  };
  await b.createHike({
    ...groupHike,
    trail_id: shared.id,
    attendee_user_ids: [a.id, b.id],
    attendee_guest_ids: [guest.id],
  });
  await a.createHike({
    ...groupHike,
    trail_id: annaShared.id,
    start_at: "2026-02-15T09:00:00+01:00",
    duration_s: 3600,
    attendee_user_ids: [a.id],
  });
  // Attended only by a guest: goes with the group, as the confirmation says.
  await a.createHike({
    ...groupHike,
    trail_id: annaShared.id,
    start_at: "2026-02-16T09:00:00+01:00",
    attendee_guest_ids: [guestOnly.id],
  });

  const anna = await signedInPage(browser, aEmail);
  const boris = await signedInPage(browser, bEmail);
  const bothHikes = {
    hikes: "2",
    distance: "14 km",
    elevation: "800 m",
    time: "3 hr",
    average: "1 hr 30 min",
  };
  const borisHike = {
    hikes: "1",
    distance: "10 km",
    elevation: "600 m",
    time: "2 hr",
    average: "2 hr",
  };

  // Anna has these pages in memory when she deletes the group.
  await anna.page.goto("/hikes");
  await expect(hikeCard(anna.page, borisTrail)).toContainText(groupName);
  await anna.page.locator("header nav").getByRole("link", { name: "Statistics" }).click();
  await expectTotals(anna.page, bothHikes);
  await anna.page.locator("header nav").getByRole("link", { name: "Trails" }).click();
  await expect(anna.page.getByRole("link", { name: borisTrail })).toBeVisible();
  await anna.page.locator("header nav").getByRole("link", { name: "Groups" }).click();
  await anna.page.getByRole("link", { name: groupName }).click();

  // She is told what will happen.
  await anna.page.getByRole("button", { name: "Delete group" }).click();
  await expect(anna.page.getByText(`Delete ${groupName}? What happens:`)).toBeVisible();
  await expect(anna.page.getByText("This cannot be undone.")).toBeVisible();
  await anna.page.getByRole("button", { name: "Yes, delete the group" }).click();
  await expect(anna.page).toHaveURL(/\/groups$/);
  await expect(anna.page.getByRole("link", { name: groupName })).toHaveCount(0);

  // Without reloading: no group, no guests, and the trail shared by Boris is gone.
  await anna.page.locator("header nav").getByRole("link", { name: "Hikes" }).click();
  const card = hikeCard(anna.page, borisTrail);
  await expect(card).toBeVisible();
  await expect(card).not.toContainText(groupName);
  await expect(card).not.toContainText("Gost Ivo");
  await expect(card).toContainText("Attended by: Anna, Boris");
  await expect(anna.page.getByText(/^2 hikes$/)).toBeVisible();
  await anna.page.locator("header nav").getByRole("link", { name: "Statistics" }).click();
  await expectTotals(anna.page, bothHikes);
  await expect(anna.page.getByLabel("Show statistics for").locator("option", { hasText: groupName }))
    .toHaveCount(0);
  await anna.page.locator("header nav").getByRole("link", { name: "Trails" }).click();
  await expect(anna.page.getByRole("link", { name: borisTrail })).toHaveCount(0);

  // The name clash: Anna's shared trail gets the group's name added.
  const renamed = `${annaTrail} (${groupName})`;
  await expect(anna.page.getByRole("link", { name: annaTrail, exact: true })).toBeVisible();
  await expect(anna.page.getByRole("link", { name: renamed })).toBeVisible();
  await anna.page.getByRole("link", { name: renamed }).click();
  await expect(anna.page.locator(".trail-badges")).toContainText("Private");
  await expect(anna.page.locator(".trail-badges")).not.toContainText(groupName);
  await expect(anna.page.getByText("4 km")).toBeVisible();
  await anna.page.goto(`/trails/${annaPrivate.id}`);
  await expect(anna.page.getByRole("heading", { name: annaTrail, exact: true })).toBeVisible();
  await anna.page.goto("/hikes");
  await expect(hikeCard(anna.page, renamed)).toBeVisible();

  // The page of the group is gone for everyone.
  const notFound = "This group does not exist or you cannot see it.";
  await anna.page.goto(`/groups/${group.id}`);
  await expect(anna.page.getByRole("alert")).toHaveText(notFound);
  await boris.page.goto(`/groups/${group.id}`);
  await expect(boris.page.getByRole("alert")).toHaveText(notFound);
  await boris.page.goto(`/stats?group=${group.id}`);
  await expect(boris.page.getByRole("alert")).toHaveText(/does not exist/);

  // The other attendee keeps the hike and its trail's name, though Anna can't see that trail now.
  await anna.page.goto(`/trails/${shared.id}`);
  await expect(anna.page.getByRole("alert")).toHaveText(/does not exist/);
  await boris.page.goto(`/trails/${shared.id}`);
  await expect(boris.page.locator(".trail-badges")).toContainText("Private");
  await boris.page.goto("/stats");
  await expectTotals(boris.page, borisHike);
  await expect(hikeCard(boris.page, borisTrail)).toContainText("Attended by: Anna, Boris");

  // With others on it, it isn't editable and removal concerns only oneself.
  await anna.page.goto("/hikes");
  const hers = hikeCard(anna.page, borisTrail);
  await expect(hers).toContainText(borisTrail);
  await expect(hers.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await hers.getByRole("button", { name: "Remove from my history" }).click();
  await expect(hers.getByText(/from your history only/)).toBeVisible();
  await hers.getByRole("button", { name: "Confirm" }).click();
  await expect(hikeCard(anna.page, borisTrail)).toHaveCount(0);
  await anna.page.goto("/stats");
  await expectTotals(anna.page, {
    hikes: "1",
    distance: "4 km",
    elevation: "200 m",
    time: "1 hr",
    average: "1 hr",
  });

  await boris.page.goto("/hikes");
  await expect(hikeCard(boris.page, borisTrail)).not.toContainText("Anna");
  // Now Boris alone is left: it's an ordinary hike of his.
  await hikeCard(boris.page, borisTrail).getByRole("link", { name: "Edit" }).click();
  await expect(boris.page.getByText("Personal hike")).toBeVisible();
  await boris.page.getByLabel("Hours").fill("3");
  await boris.page.getByRole("button", { name: "Save" }).click();
  await expect(hikeCard(boris.page, borisTrail)).toContainText("3 hr");
  await hikeCard(boris.page, borisTrail).getByRole("button", { name: "Delete" }).click();
  await hikeCard(boris.page, borisTrail).getByRole("button", { name: "Confirm" }).click();
  await boris.page.locator("header nav").getByRole("link", { name: "Statistics" }).click();
  await expectTotals(boris.page, NO_HIKES);

  expect(anna.problems).toEqual([]);
  expect(boris.problems).toEqual([]);
});

test("a plain member can't delete a group", async ({ browser }) => {
  const a = await ApiClient.as(uniqueEmail("anna"), "Anna");
  const bEmail = uniqueEmail("boris");
  const b = await ApiClient.as(bEmail, "Boris");
  const group = await a.createGroup(unique("Stays"));
  await a.addMember(group.id, b);
  const { page, problems } = await signedInPage(browser, bEmail);
  await page.goto(`/groups/${group.id}`);
  await expect(page.getByRole("button", { name: "Leave group" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete group" })).toHaveCount(0);
  expect((await b.call("DELETE", `/groups/${group.id}`)).status).toBe(403);
  expect(problems).toEqual([]);
});
