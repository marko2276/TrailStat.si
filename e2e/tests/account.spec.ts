import { readFile } from "node:fs/promises";
import { ApiClient, expect, signedInPage, test, unique, uniqueEmail } from "./helpers";

test("I can download everything stored about me", async ({ browser }) => {
  const email = uniqueEmail("export");
  const me = await ApiClient.as(email, "Izvoz");
  const trailName = unique("Moja pot");
  const trail = await me.createTrail(trailName, 5.2, 400);
  await me.post("/hikes", {
    trail_id: (trail as { id: string }).id,
    start_at: "2026-05-01T08:00:00+02:00",
    duration_s: 7200,
    notes: "Lep dan",
  });
  const { page, problems } = await signedInPage(browser, email);

  await page.goto("/profile");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download my data" }).click();
  const file = await download;

  expect(file.suggestedFilename()).toBe("trailstat-export.json");
  const data = JSON.parse(await readFile((await file.path())!, "utf-8"));
  expect(data.profile.email).toBe(email);
  expect(data.trails.map((item: { name: string }) => item.name)).toEqual([trailName]);
  expect(data.hikes[0].notes).toBe("Lep dan");
  expect(problems).toEqual([]);
});

test("deleting my account removes my data, and others keep shared hikes without my name", async ({
  browser,
}) => {
  const email = uniqueEmail("leaving");
  const leaver = await ApiClient.as(email, "Odhajajoči");
  const staying = await ApiClient.as(uniqueEmail("staying"), "Ostaja");
  const group = (await leaver.createGroup(unique("Skupina"))) as { id: string };
  await leaver.addMember(group.id, staying);
  const privateTrail = (await leaver.createTrail(unique("Skrita"), 1, 10)) as { id: string };
  const sharedTrail = (await leaver.createTrail(unique("Skupna"), 4, 300, {
    visibility: "group",
    group_id: group.id,
  })) as { id: string };
  await leaver.post("/hikes", {
    trail_id: privateTrail.id,
    start_at: "2026-05-01T08:00:00+02:00",
    duration_s: 3600,
  });
  const shared = (await staying.post("/hikes", {
    trail_id: sharedTrail.id,
    start_at: "2026-05-02T08:00:00+02:00",
    duration_s: 3600,
    group_id: group.id,
    attendee_user_ids: [leaver.id, staying.id],
    attendee_guest_ids: [],
  })) as { id: string };
  const { page, problems } = await signedInPage(browser, email);

  await page.goto("/profile");
  await page.getByRole("button", { name: "Delete my account" }).click();
  const confirm = page.getByRole("button", { name: "Delete my account permanently" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/Type your e-mail address/).fill("someone-else@example.com");
  await expect(confirm).toBeDisabled();
  await page.getByLabel(/Type your e-mail address/).fill(email);
  await confirm.click();

  // The stand-in for Hanko has no deletion flow, so this is the "login kept" path.
  await expect(page).toHaveURL(/\/account-deleted\?login=kept$/);
  await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
  await expect(page.getByText(/could not be deleted automatically/)).toBeVisible();

  // The last admin's group passed on.
  const members = await staying.get<{ items: { display_name: string; role: string }[] }>(
    `/groups/${group.id}/members`,
  );
  expect(members.items).toEqual([expect.objectContaining({ display_name: "Ostaja", role: "admin" })]);

  // The shared hike stays, without the name.
  const hike = await staying.get<{ attendees: { name: string }[] }>(`/hikes/${shared.id}`);
  expect(hike.attendees.map((attendee) => attendee.name)).toEqual(["Ostaja"]);
  expect(JSON.stringify(hike)).not.toContain("Odhajajoči");

  // Signed out: the app does not show the deleted account.
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/login$/);
  expect(problems).toEqual([]);
});

test("the privacy page is readable without an account, in both languages", async ({ browser }) => {
  for (const [locale, heading] of [
    ["en-US", "Privacy policy"],
    ["sl-SI", "Politika zasebnosti"],
  ]) {
    const context = await browser.newContext({ locale });
    const page = await context.newPage();
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await context.close();
  }
});
