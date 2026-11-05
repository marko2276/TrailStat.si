import {
  ApiClient,
  createTrailInUi,
  expect,
  expectNoHorizontalScroll,
  expectTotals,
  fillHike,
  hikeCard,
  nav,
  signedInPage,
  test,
  unique,
  uniqueEmail,
} from "./helpers";

const NOT_FOUND = "This item does not exist or you cannot see it.";

test("a private trail is invisible to others, by list and by direct URL", async ({ browser }) => {
  const owner = await ApiClient.as(uniqueEmail("owner"), "Owner");
  const name = unique("Secret path");
  const trail = await owner.createTrail(name, 5, 100);
  const other = uniqueEmail("other");
  const { page, problems } = await signedInPage(browser, other);

  await page.goto(`/trails?q=${encodeURIComponent(name)}`);
  await expect(page.getByText("No trails match your search.")).toBeVisible();
  await page.goto(`/trails/${trail.id}`);
  await expect(page.getByRole("alert")).toHaveText(NOT_FOUND);
  await page.goto(`/trails/${trail.id}/edit`);
  await expect(page.getByRole("alert")).toHaveText(NOT_FOUND);
  await expectNoHorizontalScroll(page);

  // Not on the hike form either, nor through the API.
  await page.goto("/hikes/new");
  await page.getByLabel("Search trails").fill(name);
  await expect(page.getByText("No trails found.")).toBeVisible();
  const api = await ApiClient.as(other);
  expect((await api.call("GET", `/trails/${trail.id}`)).status).toBe(404);
  expect((await api.call("PATCH", `/trails/${trail.id}`, { name: "x" })).status).toBe(404);
  expect(
    (
      await api.call("POST", "/hikes", {
        trail_id: trail.id,
        start_at: "2026-01-01T10:00:00+01:00",
        duration_s: 60,
      })
    ).status,
  ).toBe(404);
  expect(problems).toEqual([]);
});

test("a public trail is visible to all, and only its creator can edit it", async ({ browser }) => {
  const creator = uniqueEmail("creator");
  const name = unique("Public path");
  const first = await signedInPage(browser, creator);
  await first.page.goto("/trails/new");
  await createTrailInUi(first.page, { name, km: "7", gain: "300", visibility: "public" });
  await expect(first.page.getByRole("heading", { name })).toBeVisible();
  await expect(first.page.getByRole("link", { name: "Edit" })).toBeVisible();
  const trailPath = new URL(first.page.url()).pathname;

  const other = uniqueEmail("reader");
  const { page, problems } = await signedInPage(browser, other);
  await page.goto(`/trails?q=${encodeURIComponent(name)}`);
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("7 km")).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);

  await page.goto(`${trailPath}/edit`);
  await expect(page.getByRole("alert")).toHaveText("You are not allowed to do this.");
  await expect(page.getByLabel("Distance (km)")).toHaveCount(0);

  const api = await ApiClient.as(other);
  const id = trailPath.split("/").pop();
  expect((await api.call("PATCH", `/trails/${id}`, { name: "Stolen" })).status).toBe(403);
  expect((await api.call("POST", `/trails/${id}/archive`)).status).toBe(403);

  // The creator's edit reaches the other user.
  await first.page.getByRole("link", { name: "Edit" }).click();
  await first.page.getByLabel("Distance (km)").fill("7.5");
  await first.page.getByRole("button", { name: "Save" }).click();
  await expect(first.page.getByText("7.5 km")).toBeVisible();
  await page.goto(trailPath);
  await expect(page.getByText("7.5 km")).toBeVisible();
  expect(problems).toEqual([]);
  expect(first.problems).toEqual([]);
});

test("a name must be unique within its scope only", async ({ browser }) => {
  const email = uniqueEmail("names");
  const { page, problems } = await signedInPage(browser, email);
  const name = unique("Same name");
  const taken = /A trail with this name already exists here/;
  const api = await ApiClient.as(email);
  const group = await api.createGroup(unique("Names group"));

  await page.goto("/trails/new");
  await createTrailInUi(page, { name, km: "1", gain: "10" });
  await expect(page.getByRole("heading", { name })).toBeVisible();

  // Private again, also in another case: refused, with the form still filled in.
  await page.goto("/trails/new");
  await createTrailInUi(page, { name: name.toUpperCase(), km: "2", gain: "20" });
  await expect(page.getByRole("alert")).toHaveText(taken);
  await expect(page.getByLabel("Distance (km)")).toHaveValue("2");

  // The same name works as a public trail and in a group, from the same form.
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Who can see it").selectOption("public");
  await page.getByRole("button", { name: "Create trail" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.locator(".trail-badges")).toContainText("Public");

  await page.goto("/trails/new");
  await createTrailInUi(page, { name, km: "3", gain: "30", visibility: "group" });
  await expect(page.getByRole("alert")).toHaveText("Choose a group.");
  await page.getByLabel("Group", { exact: true }).selectOption(group.id);
  await page.getByRole("button", { name: "Create trail" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.locator(".trail-badges")).toContainText("Group");

  // And another user's private trail, but not their public one.
  const other = await ApiClient.as(uniqueEmail("names2"));
  expect((await other.call("POST", "/trails", body(name, "private"))).status).toBe(201);
  expect((await other.call("POST", "/trails", body(name, "public"))).status).toBe(409);
  expect(problems).toEqual([]);
});

function body(name: string, visibility: string) {
  return { name, distance_m: 1000, elevation_gain_m: 1, visibility };
}

test("archiving hides a trail for new hikes, and past hikes keep counting", async ({ browser }) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("archive"));
  const name = unique("Old path");

  // The hike form has been opened before the trail exists: it must learn about the trail.
  await page.goto("/hikes/new");
  await expect(page.getByLabel("Search trails")).toBeVisible();
  await nav(page, "Trails");
  await page.getByRole("link", { name: "Create manually" }).click();
  await createTrailInUi(page, { name, km: "10", gain: "500" });
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const trailPath = new URL(page.url()).pathname;

  await nav(page, "Hikes");
  await page.getByRole("link", { name: "Record a hike" }).click();
  await expect(page.getByRole("button", { name })).toBeVisible();
  await fillHike(page, {
    trail: name,
    date: "2026-01-15",
    time: "08:00",
    hours: "2",
    minutes: "0",
  });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(hikeCard(page, name)).toBeVisible();
  const totals = { hikes: "1", distance: "10 km", elevation: "500 m", time: "2 hr", average: "2 hr" };

  // The form has seen the trail. Now archive it, moving around inside the app.
  await page.getByRole("link", { name: "Record a hike" }).click();
  await expect(page.getByRole("button", { name })).toBeVisible();
  await nav(page, "Trails");
  await page.getByRole("link", { name }).click();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.locator(".trail-badges")).toContainText("Archived");
  await expect(page.getByText(/This trail is archived/)).toBeVisible();

  await nav(page, "Trails");
  await expect(page.getByRole("link", { name })).toHaveCount(0);
  await page.getByLabel("Show archived").check();
  await expect(page.getByRole("link", { name })).toBeVisible();
  await page.getByLabel("Show archived").uncheck();
  await expect(page.getByRole("link", { name })).toHaveCount(0);

  await nav(page, "Hikes");
  await page.getByRole("link", { name: "Record a hike" }).click();
  await expect(page.getByLabel("Search trails")).toBeVisible();
  await expect(page.getByRole("button", { name })).toHaveCount(0);
  await page.getByLabel("Search trails").fill(name);
  await expect(page.getByText("No trails found.")).toBeVisible();

  // The past hike still shows it and counts.
  await nav(page, "Hikes");
  await expect(hikeCard(page, name)).toContainText("Archived trail");
  await nav(page, "Statistics");
  await expectTotals(page, totals);
  await expect(hikeCard(page, name)).toContainText("Archived trail");

  // It stays editable after archiving, without having to choose another trail.
  await nav(page, "Hikes");
  await hikeCard(page, name).getByRole("link", { name: "Edit" }).click();
  await expect(page.getByText(name)).toBeVisible();
  await page.getByLabel("Minutes").fill("30");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(hikeCard(page, name)).toContainText("2 hr 30 min");

  // Its page is still there, and it can be restored.
  await page.goto(trailPath);
  await page.getByRole("button", { name: "Restore from archive" }).click();
  await expect(page.locator(".trail-badges")).not.toContainText("Archived");
  await nav(page, "Trails");
  await expect(page.getByRole("link", { name })).toBeVisible();
  await nav(page, "Hikes");
  await expect(hikeCard(page, name)).not.toContainText("Archived trail");
  await page.getByRole("link", { name: "Record a hike" }).click();
  await expect(page.getByRole("button", { name })).toBeVisible();
  expect(problems).toEqual([]);
});

test("renaming or changing a trail shows everywhere it is used", async ({ browser }) => {
  const { page, problems } = await signedInPage(browser, uniqueEmail("rename"));
  const name = unique("Before");
  const renamed = unique("After");
  await page.goto("/trails/new");
  await createTrailInUi(page, { name, km: "10", gain: "500" });
  await nav(page, "Hikes");
  await page.getByRole("link", { name: "Record a hike" }).click();
  await fillHike(page, { trail: name, date: "2026-01-15", time: "08:00", hours: "1", minutes: "0" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(hikeCard(page, name)).toBeVisible();
  await nav(page, "Statistics");
  await expect(page.getByText("10 km").first()).toBeVisible();

  await nav(page, "Trails");
  await page.getByRole("link", { name }).click();
  await page.getByRole("link", { name: "Edit" }).click();
  await page.getByLabel("Name", { exact: true }).fill(renamed);
  await page.getByLabel("Distance (km)").fill("20");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: renamed })).toBeVisible();

  await nav(page, "Hikes");
  await expect(hikeCard(page, renamed)).toContainText("20 km");
  await nav(page, "Statistics");
  await expectTotals(page, {
    hikes: "1",
    distance: "20 km",
    elevation: "500 m",
    time: "1 hr",
    average: "1 hr",
  });
  expect(problems).toEqual([]);
});

test("a group trail can be edited by its creator and admins, and only the creator shares", async ({
  browser,
}) => {
  const adminEmail = uniqueEmail("admin");
  const creatorEmail = uniqueEmail("creator");
  const memberEmail = uniqueEmail("member");
  const admin = await ApiClient.as(adminEmail, "Admin");
  const creator = await ApiClient.as(creatorEmail, "Creator");
  const member = await ApiClient.as(memberEmail, "Member");
  const group = await admin.createGroup(unique("Editors"));
  await admin.addMember(group.id, creator);
  await admin.addMember(group.id, member);
  const name = unique("Shared path");
  const trail = await creator.createTrail(name, 5, 100, {
    visibility: "group",
    group_id: group.id,
  });

  // A plain member reads it, and no more.
  const plain = await signedInPage(browser, memberEmail);
  await plain.page.goto(`/trails/${trail.id}`);
  await expect(plain.page.getByRole("heading", { name })).toBeVisible();
  await expect(plain.page.getByRole("link", { name: "Edit" })).toHaveCount(0);
  expect((await member.call("PATCH", `/trails/${trail.id}`, { distance_m: 1 })).status).toBe(403);

  // An admin corrects it, but isn't offered who sees it, and is refused when trying.
  const adminPage = await signedInPage(browser, adminEmail);
  await adminPage.page.goto(`/trails/${trail.id}`);
  await adminPage.page.getByRole("link", { name: "Edit" }).click();
  await expect(adminPage.page.getByLabel("Who can see it")).toHaveCount(0);
  await expect(adminPage.page.getByText(/Only the person who created this trail/)).toBeVisible();
  await adminPage.page.getByLabel("Distance (km)").fill("6");
  await adminPage.page.getByRole("button", { name: "Save" }).click();
  await expect(adminPage.page.getByText("6 km")).toBeVisible();
  await expect(adminPage.page.locator(".trail-badges")).toContainText("Group");
  expect(
    (await admin.call("PATCH", `/trails/${trail.id}`, { visibility: "public" })).status,
  ).toBe(403);

  // The creator can make it public, and it stays theirs after leaving the group.
  const creatorPage = await signedInPage(browser, creatorEmail);
  await creator.post(`/groups/${group.id}/leave`);
  await creatorPage.page.goto(`/trails/${trail.id}`);
  await expect(creatorPage.page.getByRole("heading", { name })).toBeVisible();
  await creatorPage.page.getByRole("link", { name: "Edit" }).click();
  await creatorPage.page.getByLabel("Who can see it").selectOption("public");
  await creatorPage.page.getByRole("button", { name: "Save" }).click();
  await expect(creatorPage.page.locator(".trail-badges")).toContainText("Public");

  expect(plain.problems).toEqual([]);
  expect(adminPage.problems).toEqual([]);
  expect(creatorPage.problems).toEqual([]);
});
