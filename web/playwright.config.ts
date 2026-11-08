import { defineConfig } from "@playwright/test";

// Install engines with `bunx playwright install chromium webkit`.
// Opt into Firefox with CROSSTALK_TEST_FIREFOX=1 after installing that engine.
// Some headless macOS hosts cannot start the Firefox test binary at all.
const engines = process.env.CROSSTALK_TEST_FIREFOX ? ["chromium", "webkit", "firefox"] : ["chromium", "webkit"];

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 25_000,
  // Reduce Motion by default, so a test sees every screen where it settles (fades only, no exit copies, nothing
  // gliding). CROSSTALK_E2E_MOTION=1 runs the suite with motion on, as most phones have it: nothing a test does may
  // need to wait for an animation either way. web/e2e/motion.spec.ts sets each one itself.
  use: { baseURL: "http://127.0.0.1:5198", serviceWorkers: "block", trace: "retain-on-failure", reducedMotion: process.env.CROSSTALK_E2E_MOTION ? "no-preference" : "reduce" },
  projects: engines.flatMap((browserName) =>
    [320, 390, 430, 768, 1440].map((width) => ({
      name: `${browserName}-${width}`,
      use: { browserName: browserName as "chromium" | "webkit" | "firefox", viewport: { width, height: 900 } },
    })),
  ),
  webServer: [
    // SIGTERM lets the test hub delete its temporary home and state file; by default Playwright kills it outright.
    { command: "bun e2e/hub.ts", url: "http://127.0.0.1:8451/api/health", reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 } },
    // CROSSTALK_WEB_NO_WATCH: the dev server ignores saves while the suite runs, so editing the tree can't reload
    // a page mid-test or split the app and a test's `import("/src/store.ts")` into two copies of the store.
    { command: "CROSSTALK_DEV_HUB=http://127.0.0.1:8451 CROSSTALK_WEB_NO_WATCH=1 bun run dev -- --port 5198", url: "http://127.0.0.1:5198", reuseExistingServer: false },
  ],
});
