import {
  ApiClient,
  expect,
  expectNoHorizontalScroll,
  hikeCard,
  signedInPage,
  test,
  tile,
  unique,
  uniqueEmail,
  waitForMail,
} from "./helpers";

test("an outsider sees only a public group's name and totals, then asks to join", async ({
  browser,
}) => {
  const adminEmail = uniqueEmail("anna");
  const outsiderEmail = uniqueEmail("edo");
  const admin = await ApiClient.as(adminEmail, "AnnaAdminName");
  const member = await ApiClient.as(uniqueEmail("boris"), "BorisMemberName");
  await ApiClient.as(outsiderEmail, "EdoOutsider");
  const groupName = unique("Javni planinci");
  const group = await admin.createGroup(groupName, "public");
  await admin.addMember(group.id, member);
  const guest = await admin.post<{ id: string }>(`/groups/${group.id}/guests`, {
    nickname: "GuestNicknameSecret",
  });
  const trailName = unique("Secret group trail name");
  const trail = await admin.createTrail(trailName, 10, 600, {
    visibility: "group",
    group_id: group.id,
  });
  const hike = await admin.createHike({
    trail_id: trail.id,
    start_at: "2026-02-14T09:00:00+01:00",
    duration_s: 7200,
    group_id: group.id,
    attendee_user_ids: [admin.id, member.id],
    attendee_guest_ids: [guest.id],
  });

  // Everything the outsider's browser receives is recorded.
  const { page, problems } = await signedInPage(browser, outsiderEmail);
  const responses: { url: string; status: number; body: string }[] = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/api/")) return;
    responses.push({
      url: response.url(),
      status: response.status(),
      body: await response.text().catch(() => ""),
    });
  });

  await page.goto("/groups");
  await page.getByRole("searchbox", { name: "Search by name" }).fill(groupName);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: groupName }).click();
  await expect(page.getByRole("heading", { name: groupName })).toBeVisible();

  // Exactly the summary, from the group's page and the statistics page.
  await expect(tile(page, "Hikes")).toHaveText("1");
  await expect(tile(page, "Distance")).toHaveText("10 km");
  await expect(tile(page, "Elevation gain")).toHaveText("600 m");
  await expect(tile(page, "Duration")).toHaveText("2 hr");
  await expectNoHorizontalScroll(page);
  await expect(page.getByRole("heading", { name: "Members" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Group hikes" })).toHaveCount(0);

  await page.goto(`/stats?group=${group.id}`);
  await expect(page.getByText("You aren't a member of this group")).toBeVisible();
  await expect(tile(page, "Hikes")).toHaveText("1");
  await expect(tile(page, "Total distance")).toHaveText("10 km");
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByLabel("Period")).toHaveCount(0);

  // Going straight to the group's hikes reveals nothing either.
  await page.goto(`/hikes?group=${group.id}`);
  await expect(page.getByRole("heading", { name: /Hikes|Planinci/ }).first()).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Record a hike" })).toHaveCount(0);
  await page.goto(`/hikes/new?group=${group.id}`);
  await expect(page.getByLabel("AnnaAdminName")).toHaveCount(0);
  await page.goto(`/trails/${trail.id}`);
  await expect(page.getByRole("alert")).toHaveText(/does not exist/);

  await page.goto(`/groups/${group.id}`);
  await expect(tile(page, "Hikes")).toHaveText("1");
  const visible = await page.locator("body").innerText();
  for (const secret of ["AnnaAdminName", "BorisMemberName", "GuestNicknameSecret", trailName]) {
    expect(visible, "on the page").not.toContain(secret);
    for (const response of responses) {
      expect(response.body, `in the response from ${response.url}`).not.toContain(secret);
    }
  }
  expect(responses.some((response) => response.body.includes(`About ${groupName}`))).toBe(false);

  // Asked directly, the API refuses.
  const outsider = await ApiClient.as(outsiderEmail);
  for (const path of [
    `/groups/${group.id}/members`,
    `/groups/${group.id}/guests`,
    `/groups/${group.id}/hikes`,
    `/groups/${group.id}/invitations`,
    `/groups/${group.id}/join-requests`,
    `/stats/groups/${group.id}`,
  ]) {
    expect((await outsider.call("GET", path)).status, path).toBe(403);
  }
  expect((await outsider.call("GET", `/hikes/${hike.id}`)).status).toBe(404);
  const seen = await outsider.get<Record<string, unknown>>(`/groups/${group.id}`);
  expect(seen).toMatchObject({ description: null, member_count: null, is_member: false });
  const listed = await outsider.get<{ items: Record<string, unknown>[] }>(
    `/groups?scope=public&q=${encodeURIComponent(groupName)}`,
  );
  expect(listed.items[0]).toMatchObject({ description: null, member_count: null });

  // Asking to join, and changing one's mind.
  await page.getByRole("button", { name: "Ask to join" }).click();
  await expect(page.getByRole("status").filter({ hasText: /waiting for an admin's decision/ })).toBeVisible();
  await page.getByRole("button", { name: "Cancel request" }).click();
  await expect(page.getByRole("button", { name: "Ask to join" })).toBeVisible();
  await page.getByRole("button", { name: "Ask to join" }).click();
  await expect(page.getByRole("status").filter({ hasText: /waiting for an admin's decision/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: /waiting for an admin's decision/ })).toBeVisible();

  // The admin hears about it by e-mail, and approves on the group's page.
  const mail = await waitForMail(adminEmail, /EdoOutsider/);
  expect(mail.text).toContain(`/groups/${group.id}`);
  const adminPage = await signedInPage(browser, adminEmail);
  await adminPage.page.goto(new URL(mail.text.match(/https?:\/\/\S+/)![0]).pathname);
  const requests = adminPage.page.locator('section[aria-labelledby="group-requests"]');
  await expect(requests.getByText("EdoOutsider")).toBeVisible();
  await requests.getByRole("button", { name: "Approve" }).click();
  await expect(requests.getByText("No requests are waiting.")).toBeVisible();
  await expect(
    adminPage.page.locator('section[aria-labelledby="group-members"]').getByText("EdoOutsider"),
  ).toBeVisible();

  // Now a member, the outsider sees everything.
  await page.reload();
  const members = page.locator('section[aria-labelledby="group-members"]');
  await expect(members.getByText("AnnaAdminName")).toBeVisible();
  await expect(members.getByText("BorisMemberName")).toBeVisible();
  await expect(page.getByText(`About ${groupName}`)).toBeVisible();
  await expect(
    page.locator('section[aria-labelledby="group-guests"]').getByText("GuestNicknameSecret"),
  ).toBeVisible();
  await page.getByRole("link", { name: "Group hikes" }).click();
  await expect(hikeCard(page, trailName)).toContainText(
    "Attended by: AnnaAdminName, BorisMemberName, GuestNicknameSecret",
  );
  await page.goto(`/stats?group=${group.id}`);
  await expect(page.getByRole("table").getByText("AnnaAdminName")).toBeVisible();
  await page.goto(`/trails/${trail.id}`);
  await expect(page.getByRole("heading", { name: trailName })).toBeVisible();

  expect(problems).toEqual([]);
  expect(adminPage.problems).toEqual([]);
});

test("an admin can reject a request, and the person can ask again", async ({ browser }) => {
  const admin = await ApiClient.as(uniqueEmail("anna"), "Anna");
  const outsiderEmail = uniqueEmail("edo");
  await ApiClient.as(outsiderEmail, "Edo");
  const group = await admin.createGroup(unique("Reject"), "public");
  const outsider = await signedInPage(browser, outsiderEmail);
  await outsider.page.goto(`/groups/${group.id}`);
  await outsider.page.getByRole("button", { name: "Ask to join" }).click();
  await expect(outsider.page.getByRole("button", { name: "Cancel request" })).toBeVisible();

  const requests = await admin.get<{ items: { id: string }[] }>(
    `/groups/${group.id}/join-requests`,
  );
  await admin.post(`/groups/${group.id}/join-requests/${requests.items[0].id}/reject`);

  await outsider.page.reload();
  await expect(outsider.page.getByRole("status").filter({ hasText: "Your request was rejected." })).toBeVisible();
  await outsider.page.getByRole("button", { name: "Ask again" }).click();
  await expect(outsider.page.getByRole("status").filter({ hasText: /waiting for an admin's decision/ })).toBeVisible();
  expect(outsider.problems).toEqual([]);
});

test("a private group doesn't exist for outsiders, by list or direct URL", async ({ browser }) => {
  const admin = await ApiClient.as(uniqueEmail("anna"), "Anna");
  const name = unique("Zasebni planinci");
  const group = await admin.createGroup(name);
  const outsiderEmail = uniqueEmail("edo");
  const { page, problems } = await signedInPage(browser, outsiderEmail);
  const notFound = "This group does not exist or you cannot see it.";

  await page.goto("/groups");
  await page.getByRole("searchbox", { name: "Search by name" }).fill(name);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("No public group matches your search.")).toBeVisible();

  await page.goto(`/groups/${group.id}`);
  await expect(page.getByRole("alert")).toHaveText(notFound);
  await expect(page.getByRole("button", { name: "Ask to join" })).toHaveCount(0);
  await page.goto(`/stats?group=${group.id}`);
  await expect(page.getByRole("alert")).toHaveText(/does not exist/);
  await page.goto(`/hikes?group=${group.id}`);
  await expect(page.getByRole("alert")).toHaveText(/does not exist/);
  await page.goto(`/hikes/new?group=${group.id}`);
  await expect(page.getByRole("alert").first()).toHaveText(/does not exist/);

  const outsider = await ApiClient.as(outsiderEmail);
  for (const path of [
    `/groups/${group.id}`,
    `/groups/${group.id}/members`,
    `/groups/${group.id}/hikes`,
    `/groups/${group.id}/join-requests/mine`,
    `/stats/groups/${group.id}`,
    `/stats/groups/${group.id}/summary`,
  ]) {
    expect((await outsider.call("GET", path)).status, path).toBe(404);
  }
  expect((await outsider.call("POST", `/groups/${group.id}/join-requests`)).status).toBe(404);
  expect(problems).toEqual([]);
});
