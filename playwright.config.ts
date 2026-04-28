import { defineConfig, devices } from "@playwright/test";

// Headless e2e click-through against the Vite dev server. Kept narrow on
// purpose — engine correctness is in the vitest suite; this exists to
// catch UI-level regressions (the app boots, action bar wires, undo button
// renders correctly) that pure-engine tests can't reach.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    // Vite cold-start + dataset chunk parse can push first response past the
    // 60s default in CI. Bump to 2 minutes so the first test in a fresh
    // worker doesn't race the server-up signal.
    timeout: 120000,
  },
});
