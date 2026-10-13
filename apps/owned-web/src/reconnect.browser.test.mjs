// Real Chromium: the live feed's failures are finite and visible in the T3 UI, and the UI
// reconnects without a page reload. A revoked token is a terminal, visible auth failure
// with no retry loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
const database = process.env.TEST_DATABASE_URL;
test(
  "outage shows reconnecting then recovers without reload; revoked token shows a terminal auth failure",
  { skip: !database, timeout: 120000 },
  async () => {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
    const root = resolve(import.meta.dirname, "../../.."),
      token = randomBytes(32).toString("hex"),
      other = randomBytes(32).toString("hex"),
      owner = `reconnect-${randomUUID()}`;
    const port = 43238,
      base = `http://127.0.0.1:${port}`;
    let child, browser;
    const start = async (tokens) => {
      child = spawn(process.execPath, ["dist/own-main.js"], {
        cwd: root + "/prototypes/runtime",
        env: {
          ...process.env,
          DATABASE_URL: database,
          OWNER_TOKENS: JSON.stringify(tokens),
          OWN_PORT: String(port),
          OWN_WEB_DIST: root + "/apps/owned-web/dist",
        },
        stdio: "pipe",
      });
      let errors = "";
      child.stderr.on("data", (d) => (errors += String(d)));
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(errors);
        try {
          if ((await fetch(base + "/health")).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("Backend did not start");
    };
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill("SIGTERM");
        await done;
      }
    };
    try {
      await start({ [token]: owner, [other]: owner + "-other" });
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"],
      });
      const page = await (await browser.newContext()).newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      let feedRequests = 0;
      page.on("request", (r) => {
        if (new URL(r.url()).pathname === "/api/changes") feedRequests++;
      });
      await page.goto(base);
      await page.getByLabel("Owner token").fill(token);
      await page.getByRole("button", { name: "Connect to T3" }).click();
      const composer = page.locator('[contenteditable="true"]');
      await composer.waitFor({ state: "visible" });
      await composer.fill("before outage");
      await page.getByRole("button", { name: "Submit message", exact: true }).click();
      await page
        .getByText("Deterministic fixture: before outage", { exact: false })
        .first()
        .waitFor({ state: "visible" });
      await page.evaluate(() => {
        window.__ownedNoReload = "still-here";
      });

      // 1. Outage: backend goes away. The UI must show a finite, visible state.
      await stop();
      const banner = page.getByText(/is reconnecting|is offline/).first();
      await banner.waitFor({ state: "visible", timeout: 20000 });
      assert.match(await banner.textContent(), /Owned Pi \/ Postgres/);

      // 2. Backend returns: the session reconnects by itself, no reload.
      await start({ [token]: owner, [other]: owner + "-other" });
      await page
        .getByText(/is reconnecting|is offline/)
        .first()
        .waitFor({ state: "detached", timeout: 30000 });
      assert.equal(
        await page.evaluate(() => window.__ownedNoReload),
        "still-here",
        "no page reload happened",
      );
      await composer.fill("after reconnect");
      await page.getByRole("button", { name: "Submit message", exact: true }).click();
      await page
        .getByText("Deterministic fixture: after reconnect", { exact: false })
        .first()
        .waitFor({ state: "visible" });
      // Changes made by another client while connected arrive live (the new session's feed works).
      const id = new URL(page.url()).pathname.split("/").at(-1);
      await fetch(`${base}/api/conversations/${id}/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          commandId: randomUUID(),
          kind: "prompt",
          text: "from another client",
        }),
      });
      await page
        .getByText("Deterministic fixture: from another client", { exact: false })
        .first()
        .waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => window.__ownedNoReload), "still-here");

      // 3. Auth loss: the token is revoked (backend restarts without it).
      await stop();
      await start({ [other]: owner + "-other" });
      const authBanner = page.getByText(/is offline/).first();
      await authBanner.waitFor({ state: "visible", timeout: 30000 });
      await page
        .getByText(/Sign in again/)
        .first()
        .waitFor({ state: "attached", timeout: 10000 })
        .catch(() => undefined);
      const settled = feedRequests;
      await page.waitForTimeout(4000);
      assert.ok(
        feedRequests - settled <= 1,
        `no retry loop after auth failure (saw ${feedRequests - settled} feed requests)`,
      );
      assert.equal(
        (await page.getByRole("button", { name: "Reconnect" }).count()) > 0,
        true,
        "a user-driven Reconnect action is offered",
      );
      assert.equal(await page.evaluate(() => window.__ownedNoReload), "still-here");
      assert.deepEqual(errors, []);
      console.log(
        "PASS outage visible + reconnect without reload; 401 terminal and visible, no retry loop",
      );
    } finally {
      await browser?.close();
      await stop();
    }
  },
);
