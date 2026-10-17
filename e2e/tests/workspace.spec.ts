import { api, expect, probe, send, test, waitForReply } from "../lib.ts";

test.describe.serial("workspace", () => {
  let cid = "";

  test("a short turn completes", async ({ page }) => {
    await page.goto("/");
    await send(page, "Reply with exactly: e2e ok");
    cid = await waitForReply(page, /e2e ok/i);
    await expect(page.getByText(/e2e ok/i).last()).toBeVisible();
  });

  // The preview is forwarded with its full path, so the page lives at /workspace/preview/<cid>/8080/.
  test("terminal opens and streams", async ({ page }) => {
    test.skip(!cid, "needs the conversation from the previous test");
    await page.goto("/");
    const T = (op: string, body: unknown) => api(page, `/api/conversations/${cid}/terminal/${op}`, "POST", body);
    expect((await T("open", { cols: 80, rows: 24 })).status).toBe(200);
    expect(
      (
        await T("write", {
          data: `echo term-ok > /workspace/t.txt; mkdir -p /workspace/preview/${cid}/8080 && echo '<h1>preview-ok</h1>' > /workspace/preview/${cid}/8080/index.html; (cd /workspace && python3 -m http.server 8080 >/dev/null 2>&1 &)\n`,
        })
      ).status,
    ).toBe(200);
    const got = await page.evaluate(
      (cid) =>
        new Promise<string>((res) => {
          const w = new WebSocket(
            `${location.origin.replace("http", "ws")}/api/terminal-stream?kind=attach&threadId=${cid}&terminalId=default&cols=80&rows=24`,
          );
          let out = "";
          w.onmessage = (e) => (out += String(e.data));
          w.onerror = () => res("error");
          setTimeout(() => (w.close(), res(out)), 5000);
        }),
      cid,
    );
    expect(got).toContain("term-ok");
  });

  test("files read and write", async ({ page }) => {
    test.skip(!cid, "needs the conversation");
    await page.goto("/");
    const r = await api(page, `/api/conversations/${cid}/files/read`, "POST", { path: "t.txt" });
    expect(r.status).toBe(200);
    expect(r.json.contents.trim()).toBe("term-ok");
    const w = await api(page, `/api/conversations/${cid}/files/write`, "POST", { path: "w.txt", contents: "hi", expectedVersion: "new" });
    expect(w.status).toBe(200);
    const back = await api(page, `/api/conversations/${cid}/files/read`, "POST", { path: "w.txt" });
    expect(back.json.contents).toBe("hi");
  });

  test("shared preview loads", async ({ page, context }) => {
    test.skip(!cid, "needs the conversation");
    await page.goto("/");
    expect((await api(page, `/api/conversations/${cid}/previews`, "POST", { port: 8080 })).status).toBe(200);
    const pp = await context.newPage();
    await expect
      .poll(async () => {
        const r = await pp.goto(`/preview/${cid}/8080/`);
        return `${r?.status()} ${(await pp.content()).includes("preview-ok")}`;
      }, { timeout: 30_000 })
      .toBe("200 true");
    await pp.close();
  });

  test("desktop 1280: the finished conversation reloads without chips", async ({ page }) => {
    test.skip(!cid, "needs the conversation");
    await page.goto("/");
    await page.locator(':text-is("Reply with exactly: e2e ok"):not(.sr-only)').first().click({ timeout: 30_000 });
    await expect(page.getByText(/^e2e ok\.?$/i).last()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2000);
    expect((await probe(page)).chips).toEqual([]);
    await page.screenshot({ path: "test-results/desktop-1280.png" });
  });
});
