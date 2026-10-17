import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error("set BASE_URL to the deployment, e.g. https://t3-dev.<tailnet>.ts.net");
// Extra Chromium flags, one per line (e.g. a --host-resolver-rules mapping to a local tunnel).
const args = (process.env.E2E_CHROMIUM_ARGS ?? "").split("\n").map((a) => a.trim()).filter(Boolean);
const launchOptions = { args, ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}) };
const common = {
  baseURL,
  ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "1",
  colorScheme: "dark" as const,
  storageState: ".run/state.json",
  launchOptions,
  screenshot: "only-on-failure" as const,
  trace: "retain-on-failure" as const,
};

export default defineConfig({
  testDir: "tests",
  // One throwaway account per run, shared by every test; turns hit the real model, so run serially.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  projects: [
    {
      name: "desktop",
      testIgnore: /phone\.spec/,
      use: { ...devices["Desktop Chrome"], ...common, viewport: { width: 1280, height: 900 } },
    },
    {
      name: "phone",
      testMatch: /phone\.spec/,
      use: {
        ...common,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: devices["Pixel 7"].userAgent,
      },
    },
  ],
});
