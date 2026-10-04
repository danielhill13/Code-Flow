// Browser tests: the built report and `codeflow serve`, in a real Chromium, driven as a person
// would. test/e2e/setup.ts prepares a workspace from the fake GitHub first. Run: npm run test:e2e
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/setup.ts",
  // Tests in a file share one served workspace and some edit it: one file at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
