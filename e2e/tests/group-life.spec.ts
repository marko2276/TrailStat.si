import type { Page } from "@playwright/test";
import {
  ApiClient,
  createTrailInUi,
  expect,
  expectNoHorizontalScroll,
  invitationFromMail,
  nav,
  signedInPage,
  test,
  unique,
  uniqueEmail,
} from "./helpers";

function memberRow(page: Page, name: string) {
  return page
    .locator('section[aria-labelledby="group-members"] li')
    .filter({ hasText: name });
}

const GROUP_NOT_FOUND = "This group does not exist or you cannot see it.";

test("a group from creation to invitation, roles and removal", async ({ browser }) => {
  const aEmail = uniqueEmail("anna");
  const bEmail = uniqueEmail("boris");
  const cEmail = uniqueEmail("cene");
  const a = await signedInPage(browser, aEmail);
  await ApiClient.as(aEmail, "Anna");
  const groupName = unique("Planinci");

  // A creates a private group.
  await a.page.goto("/groups");
  await a.page.getByRole("link", { name: "Create group" }).click();
  await a.page.getByLabel("Name").fill(groupName);
  await a.page.getByLabel("Description").fill("We walk on Saturdays.");
  await a.page.getByRole("button", { name: "Create group" }).click();
  await expect(a.page.getByRole("heading", { name: groupName })).toBeVisible();
  await expect(a.page.getByText("We walk on Saturdays.")).toBeVisible();
  await expect(a.page.getByText("Members: 1")).toBeVisible();
  await expectNoHorizontalScroll(a.page);
  const groupPath = new URL(a.page.url()).pathname;

  // A invites B, who has no account yet: the e-mail is in the inviter's language.
  await a.page.getByLabel("E-mail address").fill(bEmail);
  await a.page.getByRole("button", { name: "Send invitation" }).click();
  await expect(a.page.getByRole("status").filter({ hasText: `Invitation sent to ${bEmail}.` })).toBeVisible();
  await expect(a.page.getByText(bEmail).last()).toBeVisible();
  const mail = await invitationFromMail(bEmail);
  expect(mail.subject).toBe(`Anna invited you to the group ${groupName} on TrailStat`);
  expect(mail.text).toContain(`Anna invited you to join the hiking group "${groupName}"`);
  expect(mail.text).toContain("The link is valid for 7 days.");

  // Signed-in C got the forwarded link: no name of the group, and no way in.
  const c = await signedInPage(browser, cEmail);
  await c.page.goto(mail.path);
  await expect(c.page.getByRole("alert")).toHaveText(/sent to a different e-mail address/);
  await expect(c.page.getByText(`You are signed in as ${cEmail}.`)).toBeVisible();
  await expect(c.page.getByText(groupName)).toHaveCount(0);
  await expect(c.page.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expectNoHorizontalScroll(c.page);
  const cApi = await ApiClient.as(cEmail);
  expect((await cApi.call("POST", `/groups/invitations/${mail.token}/accept`)).status).toBe(403);
  expect((await cApi.call("POST", `/groups/invitations/${mail.token}/decline`)).status).toBe(403);
  const asOutsider = await cApi.call("GET", `/groups/invitations/${mail.token}`);
  expect(((await asOutsider.json()) as { group_name: unknown }).group_name).toBeNull();
  await c.page.goto(groupPath);
  await expect(c.page.getByRole("alert")).toHaveText(GROUP_NOT_FOUND);

  // B opens the link and accepts.
  const b = await signedInPage(browser, bEmail);
  await ApiClient.as(bEmail, "Boris");
  await b.page.goto(mail.path);
  await expect(
    b.page.getByText(`Anna invited you to join the group ${groupName}.`),
  ).toBeVisible();
  await expectNoHorizontalScroll(b.page);
  await b.page.getByRole("button", { name: "Accept" }).click();
  await expect(b.page).toHaveURL(new RegExp(`${groupPath}$`));
  await expect(b.page.getByRole("heading", { name: groupName })).toBeVisible();
  await expect(memberRow(b.page, "Boris")).toContainText("Member");
  await expect(memberRow(b.page, "Anna")).toContainText("Admin");
  await expect(b.page.getByText("Members: 2")).toBeVisible();
  // A plain member has no admin controls, and the list of groups knows about the new group.
  await expect(b.page.getByRole("button", { name: "Make admin" })).toHaveCount(0);
  await expect(b.page.getByRole("button", { name: "Delete group" })).toHaveCount(0);
  await expect(b.page.getByLabel("E-mail address")).toHaveCount(0);
  await nav(b.page, "Groups");
  await expect(b.page.getByRole("link", { name: groupName })).toBeVisible();

  // The used link can't be used again.
  await c.page.goto(mail.path);
  await expect(c.page.getByRole("alert")).toHaveText("This invitation has already been used.");

  // A sees B, makes them an admin, and demotes them again.
  await a.page.reload();
  await expect(a.page.getByText("No pending invitations.")).toBeVisible();
  await memberRow(a.page, "Boris").getByRole("button", { name: "Make admin" }).click();
  await expect(memberRow(a.page, "Boris")).toContainText("Admin");
  await b.page.goto(groupPath);
  await expect(b.page.getByRole("button", { name: "Delete group" })).toBeVisible();
  await expect(b.page.getByLabel("E-mail address")).toBeVisible();
  await memberRow(a.page, "Boris").getByRole("button", { name: "Remove admin role" }).click();
  await expect(memberRow(a.page, "Boris").getByRole("button", { name: "Make admin" })).toBeVisible();
  await b.page.reload();
  await expect(b.page.getByRole("heading", { name: groupName })).toBeVisible();
  await expect(b.page.getByRole("button", { name: "Delete group" })).toHaveCount(0);

  // The last admin can't leave, or stop being one.
  await a.page.getByRole("button", { name: "Leave group" }).click();
  await a.page.getByRole("button", { name: "Yes, leave" }).click();
  await expect(a.page.getByRole("alert")).toHaveText(/A group must have at least one admin/);
  await expect(a.page).toHaveURL(new RegExp(`${groupPath}$`));
  await a.page.reload();
  await memberRow(a.page, "Anna").getByRole("button", { name: "Remove admin role" }).click();
  await expect(a.page.getByRole("alert")).toHaveText(/A group must have at least one admin/);

  // A shares a trail with the group: B sees it, C doesn't.
  const trailName = unique("Group trail");
  await a.page.goto("/trails/new");
  await createTrailInUi(a.page, {
    name: trailName,
    km: "4",
    gain: "200",
    visibility: "group",
    group: groupName,
  });
  await expect(a.page.getByRole("heading", { name: trailName })).toBeVisible();
  await expect(a.page.locator(".trail-badges")).toContainText(groupName);
  const trailPath = new URL(a.page.url()).pathname;
  await b.page.goto(`/trails?q=${encodeURIComponent(trailName)}`);
  await expect(b.page.getByRole("link", { name: trailName })).toBeVisible();
  await b.page.goto(trailPath);
  await expect(b.page.getByText("4 km")).toBeVisible();
  await c.page.goto(trailPath);
  await expect(c.page.getByRole("alert")).toHaveText(/does not exist/);

  // Removed members lose access, to the group and to what is shared with it.
  await a.page.goto(groupPath);
  await memberRow(a.page, "Boris").getByRole("button", { name: "Remove", exact: true }).click();
  await a.page.getByRole("button", { name: "Remove from group" }).click();
  await expect(memberRow(a.page, "Boris")).toHaveCount(0);
  await expect(a.page.getByText("Members: 1")).toBeVisible();
  await b.page.goto(groupPath);
  await expect(b.page.getByRole("alert")).toHaveText(GROUP_NOT_FOUND);
  await b.page.goto(trailPath);
  await expect(b.page.getByRole("alert")).toHaveText(/does not exist/);
  await b.page.goto("/groups");
  await expect(b.page.getByRole("link", { name: groupName })).toHaveCount(0);
  const bApi = await ApiClient.as(bEmail);
  const groupId = groupPath.split("/").pop();
  expect((await bApi.call("GET", `/groups/${groupId}/members`)).status).toBe(404);
  expect((await bApi.call("GET", `/groups/${groupId}/hikes`)).status).toBe(404);
  expect((await bApi.call("GET", `/stats/groups/${groupId}`)).status).toBe(404);

  expect(a.problems).toEqual([]);
  expect(b.problems).toEqual([]);
  expect(c.problems).toEqual([]);
});

test("an invitation e-mail uses the language of the recipient, or else of the inviter", async ({
  browser,
}) => {
  const inviter = await ApiClient.as(uniqueEmail("inviter"), "Irena", "sl");
  const group = await inviter.createGroup(unique("Jezik"));

  // Without an account: the inviter's language, Slovenian.
  const newcomer = uniqueEmail("newcomer");
  await inviter.post(`/groups/${group.id}/invitations`, { email: newcomer });
  const forNewcomer = await invitationFromMail(newcomer);
  expect(forNewcomer.subject).toContain("vas vabi v skupino");
  expect(forNewcomer.text).toContain("Pozdravljeni!");
  expect(forNewcomer.text).not.toContain("Hello");

  // With an account in English: English, whatever the inviter's language.
  const english = await ApiClient.as(uniqueEmail("english"), "Ed", "en");
  await inviter.post(`/groups/${group.id}/invitations`, { email: english.email });
  const forEnglish = await invitationFromMail(english.email);
  expect(forEnglish.subject).toContain("invited you to the group");
  expect(forEnglish.text).toContain("Hello,");

  // And the other way round.
  const slovene = await ApiClient.as(uniqueEmail("slovene"), "Sara", "sl");
  const englishAdmin = await ApiClient.as(uniqueEmail("admin"), "Adam", "en");
  const other = await englishAdmin.createGroup(unique("Language"));
  await englishAdmin.post(`/groups/${other.id}/invitations`, { email: slovene.email });
  const forSlovene = await invitationFromMail(slovene.email);
  expect(forSlovene.subject).toContain("vas vabi v skupino");

  // A Slovenian reader sees the invitation in Slovenian too.
  const { page, problems } = await signedInPage(browser, slovene.email, { locale: "en-US" });
  await page.goto(forSlovene.path);
  await expect(page.getByRole("button", { name: "Sprejmi" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("a revoked or replaced invitation link stops working", async ({ browser }) => {
  const admin = await ApiClient.as(uniqueEmail("admin"), "Adam");
  const group = await admin.createGroup(unique("Revoke"));
  const guestEmail = uniqueEmail("invitee");
  const { page, problems } = await signedInPage(browser, guestEmail);
  const invitation = await admin.post(`/groups/${group.id}/invitations`, { email: guestEmail });
  const first = await invitationFromMail(guestEmail);

  await admin.post(`/groups/${group.id}/invitations/${invitation.id}/resend`);
  await expect.poll(async () => (await invitationFromMail(guestEmail)).token).not.toBe(first.token);
  const second = await invitationFromMail(guestEmail);
  await page.goto(first.path);
  await expect(page.getByRole("alert")).toHaveText(/This invitation link is not valid/);

  await page.goto(second.path);
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("status").filter({ hasText: "You declined the invitation." })).toBeVisible();
  await page.goto(second.path);
  await expect(page.getByRole("alert")).toHaveText("This invitation has already been used.");
  expect(problems).toEqual([]);
});

test("the second admin lets the first one leave", async ({ browser }) => {
  const aEmail = uniqueEmail("first");
  const first = await ApiClient.as(aEmail, "First");
  const second = await ApiClient.as(uniqueEmail("second"), "Second");
  const name = unique("Handover");
  const group = await first.createGroup(name);
  await first.addMember(group.id, second);
  const memberId = second.id;
  expect(
    (await first.call("PATCH", `/groups/${group.id}/members/${memberId}`, { role: "admin" })).status,
  ).toBe(200);

  const { page, problems } = await signedInPage(browser, aEmail);
  await page.goto(`/groups/${group.id}`);
  await page.getByRole("button", { name: "Leave group" }).click();
  await page.getByRole("button", { name: "Yes, leave" }).click();
  await expect(page).toHaveURL(/\/groups$/);
  await expect(page.getByRole("link", { name })).toHaveCount(0);
  await page.goto(`/groups/${group.id}`);
  await expect(page.getByRole("alert")).toHaveText(GROUP_NOT_FOUND);
  expect(problems).toEqual([]);
});

test("invitation errors are explained, and a renamed group is renamed everywhere", async ({
  browser,
}) => {
  const email = uniqueEmail("anna");
  const a = await ApiClient.as(email, "Anna");
  const b = await ApiClient.as(uniqueEmail("boris"), "Boris");
  const name = unique("Old name");
  const newName = unique("New name");
  const group = await a.createGroup(name);
  await a.addMember(group.id, b);
  const trail = await a.createTrail(unique("Rename trail"), 1, 1, {
    visibility: "group",
    group_id: group.id,
  });
  await a.createHike({
    trail_id: trail.id,
    start_at: "2026-02-14T09:00:00+01:00",
    duration_s: 60,
    group_id: group.id,
    attendee_user_ids: [a.id],
  });
  const { page, problems } = await signedInPage(browser, email);

  // These are seen before the rename.
  await page.goto("/hikes");
  await expect(page.locator("article")).toContainText(name);
  await page.locator("header nav").getByRole("link", { name: "Groups" }).click();
  await page.getByRole("link", { name }).click();

  const input = page.getByLabel("E-mail address");
  const send = page.getByRole("button", { name: "Send invitation" });
  await input.fill(b.email);
  await send.click();
  await expect(page.getByRole("alert")).toHaveText("This person is already a member of the group.");
  const invited = uniqueEmail("pending");
  await input.fill(invited);
  await send.click();
  await expect(page.getByRole("status").filter({ hasText: `Invitation sent to ${invited}.` })).toBeVisible();
  await input.fill(invited.toUpperCase());
  await send.click();
  await expect(page.getByRole("alert")).toHaveText(/An invitation for this address is already waiting/);

  // A revoked link stops working.
  const pending = page.locator('section[aria-labelledby="group-invitations"] li');
  const { path } = await invitationFromMail(invited);
  await pending.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke invitation" }).click();
  await expect(page.getByText("No pending invitations.")).toBeVisible();
  const other = await signedInPage(browser, invited);
  await other.page.goto(path);
  await expect(other.page.getByRole("alert")).toHaveText("This invitation has been revoked.");

  // Rename.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(newName);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: newName })).toBeVisible();
  await page.locator("header nav").getByRole("link", { name: "Hikes" }).click();
  await expect(page.locator("article")).toContainText(newName);
  await page.locator("header nav").getByRole("link", { name: "Statistics" }).click();
  await expect(page.getByLabel("Show statistics for").locator("option", { hasText: newName })).toHaveCount(1);
  expect(problems).toEqual([]);
  expect(other.problems).toEqual([]);
});
