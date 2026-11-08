import { expect, signedInPage, test, uniqueEmail } from "./helpers";

test("the admin sees totals; nobody else sees the page", async ({ browser }) => {
  const { page, problems, context } = await signedInPage(browser, "admin@example.com");
  await page.goto("/");
  await page.getByRole("link", { name: "Admin" }).click();

  await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
  for (const section of ["Users", "Content", "Database", "Server"]) {
    await expect(page.getByRole("heading", { name: section })).toBeVisible();
  }
  await expect(page.getByText("e2e", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "users", exact: true })).toBeVisible();
  // The synthetic elevation tile of the e2e stack.
  await expect(page.getByText(/^1 tile, /)).toBeVisible();
  expect(problems).toEqual([]);
  await context.close();

  const other = await signedInPage(browser, uniqueEmail("not-admin"));
  await other.page.goto("/");
  await expect(other.page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(other.page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  await other.page.goto("/admin");
  await expect(other.page.getByText("This page does not exist.")).toBeVisible();
  const response = await other.page.request.get("/api/admin/stats");
  expect(response.status()).toBe(401);
  await other.context.close();
});
