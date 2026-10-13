// Real Chromium + two backend workers sharing one Postgres. A worker crashes mid-run, a steer
// for that run arrives at the surviving worker, the lease expires and the survivor recovers:
// the steer is rejected (never run) and the T3 UI offers "Send as new message".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
const database = process.env.TEST_DATABASE_URL;
test(
  "stale steer after a worker crash is rejected and can be sent as a new message from the T3 UI",
  { skip: !database, timeout: 90000 },
  async () => {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
    const root = resolve(import.meta.dirname, "../../.."),
      token = randomBytes(32).toString("hex"),
      owner = `steer-ui-${randomUUID()}`;
    const children = new Map();
    const start = async (port) => {
      const child = spawn(process.execPath, ["dist/own-main.js"], {
        cwd: root + "/prototypes/runtime",
        env: {
          ...process.env,
          DATABASE_URL: database,
          OWNER_TOKENS: JSON.stringify({ [token]: owner }),
          OWN_PORT: String(port),
          OWN_LEASE_MS: "1500",
          OWN_WEB_DIST: root + "/apps/owned-web/dist",
        },
        stdio: "pipe",
      });
      let errors = "";
      child.stderr.on("data", (d) => (errors += String(d)));
      children.set(port, child);
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(errors);
        try {
          if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("Backend did not start");
    };
    const kill = async (port, signal = "SIGKILL") => {
      const child = children.get(port);
      if (child && child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill(signal);
        await done;
      }
    };
    const api = (port, path, body) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const until = async (port, id, predicate) => {
      for (let i = 0; i < 300; i++) {
        const c = await (await api(port, `/api/conversations/${id}`)).json();
        if (predicate(c)) return c;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("state not reached");
    };
    let browser;
    try {
      await start(43236);
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"],
      });
      const context = await browser.newContext(),
        page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const login = async (p, port) => {
        await p.goto(`http://127.0.0.1:${port}`);
        await p.getByLabel("Owner token").fill(token);
        await p.getByRole("button", { name: "Connect to T3" }).click();
        await p.locator('[contenteditable="true"]').waitFor({ state: "visible" });
      };
      await login(page, 43236);
      const composer = page.locator('[contenteditable="true"]');
      await composer.fill("/fixture wait");
      await page.getByRole("button", { name: "Submit message", exact: true }).click();
      await page.waitForURL(
        (url) => !url.pathname.includes("/draft/") && url.pathname.split("/").length > 2,
      );
      const threadPath = new URL(page.url()).pathname,
        id = threadPath.split("/").at(-1);
      const running = await until(43236, id, (c) => c.jobs.some((j) => j.status === "running"));
      const runId = running.jobs.find((j) => j.status === "running").id;
      await start(43237);
      await kill(43236);
      // The steer reaches the surviving worker while the run is still durably "running".
      const steerId = `steer-${randomUUID()}`;
      const accepted = await api(43237, `/api/conversations/${id}/commands`, {
        commandId: steerId,
        kind: "steer",
        text: "/fixture write resent.txt sent as new message",
        targetJobId: runId,
      });
      assert.equal(accepted.status, 202);
      // Survivor's sweeper recovers once the crashed worker's lease expires.
      const recovered = await until(
        43237,
        id,
        (c) => c.jobs.find((j) => j.id === steerId)?.status === "rejected",
      );
      assert.equal(recovered.jobs.find((j) => j.id === runId).status, "interrupted");
      assert.equal(
        recovered.events.find((e) => e.type === "steering.rejected")?.data.code,
        "STEER_TARGET_RECOVERED",
      );
      assert.ok(
        !recovered.events.some((e) => e.type === "run.started" && e.data.jobId === steerId),
        "the stale steer never started a run",
      );
      const page2 = await context.newPage();
      page2.on("pageerror", (e) => errors.push(String(e)));
      await login(page2, 43237);
      await page2.goto(`http://127.0.0.1:43237${threadPath}`);
      const notice = page2.getByRole("alert").filter({ hasText: "Steer not applied" });
      await notice.waitFor({ state: "visible" });
      assert.match(await notice.textContent(), /sent as new message/);
      await notice.getByRole("button", { name: "Send as new message" }).click();
      await notice.waitFor({ state: "detached" });
      const done = await until(
        43237,
        id,
        (c) => c.jobs.find((j) => j.id === `resend-${steerId}`)?.status === "done",
      );
      assert.equal(done.jobs.find((j) => j.id === steerId).status, "rejected");
      await page2
        .getByText("File written in deterministic fixture", { exact: false })
        .last()
        .waitFor({ state: "visible" });
      await page2.reload();
      await page2.locator('[contenteditable="true"]').waitFor({ state: "visible" });
      await page2.waitForTimeout(500);
      assert.equal(
        await page2.getByRole("alert").filter({ hasText: "Steer not applied" }).count(),
        0,
        "handled notice does not come back",
      );
      assert.deepEqual(errors, []);
      console.log(
        "PASS stale steer rejected across workers; UI resend creates exactly one new run",
      );
    } finally {
      await browser?.close();
      for (const port of children.keys()) await kill(port, "SIGTERM");
    }
  },
);
