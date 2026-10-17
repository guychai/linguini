import { chromium, type FullConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

// Creates this run's throwaway account through the sign-up screen and saves its session.
export default async function setup(config: FullConfig) {
  const use = config.projects[0]!.use;
  const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const a = {
    runId,
    email: `e2e-${runId}-user@test.linguini`,
    password: `pw-${randomBytes(12).toString("hex")}`,
    name: "E2E Probe",
  };
  mkdirSync(".run", { recursive: true });
  writeFileSync(".run/account.json", JSON.stringify(a));
  console.log(`e2e run ${runId}: account ${a.email}`);
  const browser = await chromium.launch(use.launchOptions);
  try {
    const ctx = await browser.newContext({ baseURL: use.baseURL, ignoreHTTPSErrors: use.ignoreHTTPSErrors });
    const p = await ctx.newPage();
    await p.goto("/");
    await p.waitForSelector(".lg-auth-card", { timeout: 60_000 });
    await p.click(".lg-auth-switch button");
    await p.fill('input[name="name"]', a.name);
    await p.fill('input[name="email"]', a.email);
    await p.fill('input[name="password"]', a.password);
    await p.click('button[type="submit"]');
    await p.locator('[aria-label="Message"]:visible').first().waitFor({ timeout: 60_000 });
    await ctx.storageState({ path: ".run/state.json" });
  } finally {
    await browser.close();
  }
}
