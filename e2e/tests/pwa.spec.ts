import type { BrowserContext, Page } from "@playwright/test";
import {
  ApiClient,
  expect,
  invitationFromMail,
  signedInPage,
  stubMapStyle,
  test,
  tokenFor,
  unique,
  uniqueEmail,
  watchProblems,
} from "./helpers";

async function serviceWorkerReady(page: Page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      registration.active?.postMessage({ type: "SKIP_WAITING" });
    });
  });
}

/** What Hanko's sign-in component does when it succeeds: it stores the session and says so. */
async function signInThroughHanko(page: Page, context: BrowserContext, email: string) {
  await context.addCookies([
    { name: "hanko", value: await tokenFor(email), domain: "localhost", path: "/" },
  ]);
  await page.evaluate(() => {
    const expiration = new Date(Date.now() + 3_600_000).toISOString();
    const claims = { subject: "e2e", expiration, session_id: "e2e" };
    document.dispatchEvent(
      new CustomEvent("hanko-session-created", {
        detail: { claims, expirationSeconds: 3600, userID: "e2e" },
      }),
    );
  });
}

test("the service worker registers, and /api never gets the cached app shell", async ({
  browser,
}) => {
  const email = uniqueEmail("pwa");
  const { page, problems } = await signedInPage(browser, email);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await serviceWorkerReady(page);
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  // Fetches from the page, while the worker controls it.
  const answers = await page.evaluate(async () => {
    const read = async (path: string) => {
      const response = await fetch(path);
      return {
        status: response.status,
        type: response.headers.get("content-type") ?? "",
        body: await response.text(),
      };
    };
    return [await read("/api/health"), await read("/api/no/such/endpoint"), await read("/api/me")];
  });
  for (const answer of answers) {
    expect(answer.type).toContain("application/json");
    expect(answer.body).not.toContain('id="root"');
  }
  expect(answers[0].status).toBe(200);
  expect(answers[1].status).toBe(404);
  expect(answers[2].status).toBe(401);

  // Navigations, which is what the worker's fallback answers.
  for (const path of ["/api/health", "/api/no/such/endpoint"]) {
    const response = await page.goto(path);
    expect(response!.headers()["content-type"]).toContain("application/json");
    expect(await response!.text()).not.toContain('id="root"');
  }
  const docs = await page.goto("/api/docs");
  expect(await docs!.text()).toContain("swagger");
  expect(problems).toEqual([]);
});

test("with the worker active, the app still loads its data, and deep links work", async ({
  browser,
}) => {
  const email = uniqueEmail("pwa-data");
  const api = await ApiClient.as(email, "Sara");
  const name = unique("Worker trail");
  const trail = await api.createTrail(name, 1, 1);
  const { page, problems } = await signedInPage(browser, email);
  await page.goto("/");
  await serviceWorkerReady(page);
  await page.goto(`/trails/${trail.id}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  expect(problems).toEqual([]);
});

test("the app shell itself loads without a network", async ({ browser }) => {
  const { page, context } = await signedInPage(browser, uniqueEmail("offline"));
  await page.goto("/");
  await serviceWorkerReady(page);
  await context.setOffline(true);
  await page.reload();
  // Offline use isn't in scope for the app: it must just not be a browser error page.
  await expect(page.locator("header .brand")).toBeVisible();
  await context.setOffline(false);
});

test("deep links reload through Caddy", async ({ browser, request }) => {
  const email = uniqueEmail("deep");
  const api = await ApiClient.as(email, "Sara");
  const trailName = unique("Deep trail");
  const groupName = unique("Deep group");
  const trail = await api.createTrail(trailName, 1, 1);
  const group = await api.createGroup(groupName);
  const invited = uniqueEmail("deep-invited");
  await api.post(`/groups/${group.id}/invitations`, { email: invited });
  const invitation = await invitationFromMail(invited);

  // Without a service worker: the server answers with the app, and headers that allow updates.
  for (const path of [`/trails/${trail.id}`, `/groups/${group.id}`, invitation.path]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
    expect(await response.text()).toContain('id="root"');
    expect(response.headers()["cache-control"]).toBe("no-cache");
  }

  const owner = await signedInPage(browser, email);
  await owner.page.goto(`/trails/${trail.id}`);
  await expect(owner.page.getByRole("heading", { name: trailName })).toBeVisible();
  await owner.page.reload();
  await expect(owner.page.getByRole("heading", { name: trailName })).toBeVisible();
  await owner.page.goto(`/groups/${group.id}`);
  await owner.page.reload();
  await expect(owner.page.getByRole("heading", { name: groupName })).toBeVisible();

  const guest = await signedInPage(browser, invited);
  await guest.page.goto(invitation.path);
  await guest.page.reload();
  await expect(guest.page.getByRole("button", { name: "Accept" })).toBeVisible();
  expect(owner.problems).toEqual([]);
  expect(guest.problems).toEqual([]);
});

test("signing in from an invitation link returns to the invitation", async ({ browser }) => {
  const admin = await ApiClient.as(uniqueEmail("admin"), "Adam");
  const groupName = unique("Vabilo");
  const group = await admin.createGroup(groupName);
  const invited = uniqueEmail("signed-out");
  await admin.post(`/groups/${group.id}/invitations`, { email: invited });
  const invitation = await invitationFromMail(invited);

  // Signed out, on a device that has never seen the app.
  const context = await browser.newContext({ locale: "en-US" });
  await stubMapStyle(context);
  const page = await context.newPage();
  const problems = watchProblems(page);
  await page.goto(invitation.path);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("hanko-auth")).toBeAttached();

  await signInThroughHanko(page, context, invited);

  await expect(page).toHaveURL(new RegExp(`${invitation.path}$`));
  await expect(page.getByText(`Adam invited you to join the group ${groupName}.`)).toBeVisible();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("heading", { name: groupName })).toBeVisible();
  expect(problems).toEqual([]);
});

test("the wrong account can switch from an invitation, and comes back to it", async ({
  browser,
}) => {
  const admin = await ApiClient.as(uniqueEmail("admin"), "Adam");
  const groupName = unique("Zamenjava");
  const group = await admin.createGroup(groupName);
  const invited = uniqueEmail("right-account");
  await admin.post(`/groups/${group.id}/invitations`, { email: invited });
  const invitation = await invitationFromMail(invited);

  const { page, context, problems } = await signedInPage(browser, uniqueEmail("wrong-account"));
  await page.goto(invitation.path);
  await page.getByRole("button", { name: "Sign in with another account" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await signInThroughHanko(page, context, invited);
  await expect(page).toHaveURL(new RegExp(`${invitation.path}$`));
  await expect(page.getByText(`Adam invited you to join the group ${groupName}.`)).toBeVisible();
  expect(problems).toEqual([]);
});
