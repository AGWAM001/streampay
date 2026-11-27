import { defineConfig } from "@playwright/test";

/** Interaction tests for the real Next.js settings page (not Storybook). */
const PORT = 3008;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.theme.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  outputDir: "test-results/theme",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1024, height: 768 },
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/settings`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
