// Two projects: `unit`, the fast tests beside the code, and `scenarios`, which run the real CLI
// against a fake GitHub server. Browser tests are Playwright's (playwright.config.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "scenarios",
          include: ["test/**/*.test.ts"],
          // Each test runs the CLI as its own process; a full sync takes a few seconds.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/testing/**", "src/report/main.tsx"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});
