import { expect, send, test, waitForReply } from "../lib.ts";

test("visual reply renders as a card", async ({ page }) => {
  await page.goto("/");
  await send(
    page,
    "Use the html_render tool to render a tiny page with an inline svg of 3 bars, titled Bars. Then reply with exactly: visual done",
  );
  await waitForReply(page, /visual done/i);
  const frame = page.locator('iframe[src*="/render/"]').first();
  await expect(frame).toBeVisible({ timeout: 60_000 });
  expect((await frame.boundingBox())!.height).toBeGreaterThan(50);
  await page.screenshot({ path: "test-results/visual-1280.png" });
});
