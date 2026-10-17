import { expect, probe, send, test, waitForReply } from "../lib.ts";

// 390 px touch layout (phone project): send by tapping, the empty model tray stays hidden.
test("phone: turn by tap, no chips, empty tray hidden", async ({ page }) => {
  await page.goto("/");
  await send(page, "Reply with exactly: phone ok", { tap: true });
  await waitForReply(page, /phone ok/i);
  await expect(page.getByText(/phone ok/i).last()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  expect((await probe(page)).chips).toEqual([]);
  const tray = await page.evaluate(() => {
    const e = document.querySelector("[data-composer-model-strip]");
    if (!e) return "absent";
    const r = e.getBoundingClientRect();
    return getComputedStyle(e).visibility === "hidden" || r.height === 0 ? "hidden" : "visible";
  });
  expect(tray).not.toBe("visible");
  await page.screenshot({ path: "test-results/phone-390.png" });
});
