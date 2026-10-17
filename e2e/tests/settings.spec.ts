import { expect, test } from "../lib.ts";

test("theme switches and switches back", async ({ page }) => {
  await page.goto("/settings/appearance");
  await page.waitForSelector(".lg-admin-form", { timeout: 60_000 });
  const dark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
  await page.locator('[aria-label="Use light mode"]').first().click();
  await expect.poll(dark).toBe(false);
  await page.locator('[aria-label="Use dark mode"]').first().click();
  await expect.poll(dark).toBe(true);
  await page.screenshot({ path: "test-results/settings-1280.png" });
});
