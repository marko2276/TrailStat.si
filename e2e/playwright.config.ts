import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_APP_PORT ?? "18080";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./results",
  timeout: 60_000,
  retries: 0,
  // Tests create their own users with unique e-mail addresses, so they don't share data.
  workers: 4,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
