// Playwright config for the composer smoke tests.
//
// Both servers are started for you: the mock opencode2 the frontend talks to,
// and the Vite dev server that proxies to it. `npm test` is the whole workflow.
//
// The suite is deliberately small — it covers the composer, which is the most
// stateful part of the UI and the part with no other safety net. It is not a
// full regression suite, and shouldn't grow into one without a reason.
import { defineConfig, devices } from "@playwright/test";

const VITE_PORT = 5173;
const MOCK_PORT = 4096;

export default defineConfig({
  testDir: "./test",
  // The dev server is shared, so parallel workers would fight over the same
  // localStorage-backed session state.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? "list" : [["list"]],
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Normally Playwright uses the browser `npx playwright install chromium`
        // put in its own cache. Sandboxes and CI images often ship a Chromium
        // that doesn't match this package's expected build number, which fails
        // with "Executable doesn't exist"; point this at that binary instead of
        // pinning the package to whatever one machine happens to have.
        ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: [
    {
      command: "node test/mock-opencode.js",
      url: `http://127.0.0.1:${MOCK_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
    {
      command: "npm run dev",
      url: `http://localhost:${VITE_PORT}/`,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
  ],
});
