import { conversations, expect, probe, send, STOP, test, waitForReply } from "../lib.ts";

// The one long, real-model turn: a reply long enough to watch it stream.
test("streaming turn: no status chips, Working for + stop, then interrupt", async ({ page }) => {
  await page.goto("/");
  await send(page, "Write a ten paragraph essay on cheese.");
  const mid: Awaited<ReturnType<typeof probe>>[] = [];
  let sawStream = false;
  for (let i = 0; i < 120; i++) {
    // Alternate hovering the latest message (upstream reveals message meta on hover) and not.
    if (i % 2) await page.locator("text=/cheese/i").last().hover().catch(() => {});
    else await page.mouse.move(5, 5);
    const s = await probe(page);
    if (s.working || s.stop) {
      sawStream = true;
      mid.push(s);
      if (mid.length === 3) await page.screenshot({ path: "test-results/stream-midstream-1280.png" });
    } else if (sawStream) break;
    await page.waitForTimeout(2000);
  }
  expect(sawStream, "the turn streamed").toBe(true);
  expect(mid.filter((s) => s.chips.length), "no status chips mid-stream").toEqual([]);
  expect(mid.some((s) => s.working), "Working for … shown").toBe(true);
  expect(mid.some((s) => s.stop), "stop button shown").toBe(true);
  await page.waitForTimeout(3000);
  for (const hover of [false, true]) {
    if (hover) await page.locator("text=/cheese/i").last().hover().catch(() => {});
    else await page.mouse.move(5, 5);
    const s = await probe(page);
    expect(s, `settled (hover=${hover})`).toEqual({ chips: [], working: false, stop: false });
  }
  await page.screenshot({ path: "test-results/stream-complete-1280.png" });

  // Interrupt a second long turn.
  await send(page, "Write a twenty paragraph essay on the history of bread.");
  await page.locator(STOP).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  await page.locator(STOP).click();
  await expect.poll(async () => (await probe(page)).stop, { timeout: 60_000 }).toBe(false);
  await expect.poll(async () => (await probe(page)).working).toBe(false);
  expect((await probe(page)).chips, "no chips after interrupt").toEqual([]);
  const statuses = (await conversations(page)).flatMap((c) => c.jobs.map((j) => j.status));
  expect(statuses).toContain("cancelled");
  // keep the cheap check honest: the first turn finished normally
  await waitForReply(page, /cheese/i, 10_000);
});
