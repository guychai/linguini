// Real Chromium + two backend workers sharing one Postgres. Worker A is SIGKILLed after a
// non-idempotent tool call took effect but before its observation was committed. Worker B
// recovers it as "outcome unknown": the T3 UI shows the blocked state on the tool call and
// the conversation, new work waits, and "Mark not applied" resolves it through the same
// owner-authorized API as every other conversation action.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
const database = process.env.TEST_DATABASE_URL;
test(
  "unknown tool outcome blocks the conversation in the T3 UI until marked applied or not applied",
  { skip: !database, timeout: 120000 },
  async () => {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
    const root = resolve(import.meta.dirname, "../../.."),
      dir = mkdtempSync(join(tmpdir(), "outcome-ui-")),
      token = randomBytes(32).toString("hex"),
      otherToken = randomBytes(32).toString("hex"),
      owner = `outcome-ui-${randomUUID()}`;
    const children = new Map();
    const start = async (port, extra = {}) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/ledger-ui-server.ts"], {
        cwd: root + "/prototypes/runtime",
        env: {
          ...process.env,
          DATABASE_URL: database,
          OWNER_TOKENS: JSON.stringify({ [token]: owner, [otherToken]: `${owner}-other` }),
          OWN_PORT: String(port),
          OWN_LEASE_MS: "1000",
          OWN_WEB_DIST: root + "/apps/owned-web/dist",
          LEDGER_DEST: join(dir, "destination.sqlite"),
          ...extra,
        },
        stdio: "pipe",
      });
      let errors = "";
      child.stderr.on("data", (d) => (errors += String(d)));
      children.set(port, child);
      for (let i = 0; i < 200; i++) {
        if (child.exitCode !== null) throw new Error(errors);
        try {
          if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("Backend did not start");
    };
    const stop = async (port) => {
      const child = children.get(port);
      if (child && child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill("SIGTERM");
        await done;
      }
    };
    const api = (port, path, body, bearer = token) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          "content-type": "application/json",
        },
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
    const effects = () => {
      const db = new DatabaseSync(join(dir, "destination.sqlite"));
      try {
        return Number(db.prepare("SELECT count(*) AS n FROM effects").get().n);
      } finally {
        db.close();
      }
    };
    let browser;
    try {
      const A = await start(43240, { LEDGER_KILL_AT: "after-effect" });
      const killed = once(A, "exit");
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"],
      });
      const context = await browser.newContext(),
        errors = [];
      const login = async (port) => {
        const p = await context.newPage();
        p.on("pageerror", (e) => errors.push(String(e)));
        await p.goto(`http://127.0.0.1:${port}`);
        await p.getByLabel("Owner token").fill(token);
        await p.getByRole("button", { name: "Connect to T3" }).click();
        await p.locator('[contenteditable="true"]').waitFor({ state: "visible" });
        return p;
      };
      const page = await login(43240);
      await page.locator('[contenteditable="true"]').fill("/ledger edit the config");
      await page.getByRole("button", { name: "Submit message", exact: true }).click();
      await page.waitForURL(
        (url) => !url.pathname.includes("/draft/") && url.pathname.split("/").length > 2,
      );
      const threadPath = new URL(page.url()).pathname,
        id = threadPath.split("/").at(-1);
      // Worker A dies after the destination applied the edit, before the observation commit.
      assert.equal((await killed)[1], "SIGKILL");
      assert.equal(effects(), 1);
      await page.close();
      await start(43241);
      const blocked = await until(43241, id, (c) => (c.toolOutcomesUnknown ?? []).length === 1);
      const [unknown] = blocked.toolOutcomesUnknown;
      assert.equal(unknown.tool, "edit");

      const page2 = await login(43241);
      await page2.goto(`http://127.0.0.1:43241${threadPath}`);
      const banner = page2.getByRole("alert").filter({ hasText: "Conversation blocked" });
      await banner.waitFor({ state: "visible" });
      assert.match(await banner.textContent(), /tool outcome unknown/);
      assert.match(await banner.textContent(), /edit \(sandbox\)/);
      // The tool call itself shows the unknown state.
      // The tool call row itself (not just the banner) shows the unknown state; the
      // interrupted turn folds its calls under "You stopped after …", so open it.
      await page2
        .getByText(/^(Worked for|You stopped after)/)
        .first()
        .click();
      await page2
        .getByText(/^edit: outcome unknown, conversation blocked$/i)
        .first()
        .waitFor({ state: "visible" });

      // Same authorization as other conversation actions: no token, or another owner, is refused.
      const route = `/api/conversations/${id}/ledger/${unknown.execId}/resolve`;
      assert.equal((await api(43241, route, { outcome: "applied" }, "")).status, 401);
      assert.equal((await api(43241, route, { outcome: "applied" }, otherToken)).status, 404);
      assert.equal((await until(43241, id, () => true)).toolOutcomesUnknown.length, 1);

      // New work queues but does not run while blocked.
      await page2.locator('[contenteditable="true"]').fill("/ledger read after resolution");
      await page2.getByRole("button", { name: "Submit message", exact: true }).click();
      const waiting = await until(43241, id, (c) =>
        c.jobs.some((j) => j.text === "/ledger read after resolution" && j.blockedOn?.length),
      );
      assert.equal(
        waiting.jobs.find((j) => j.text === "/ledger read after resolution").status,
        "queued",
      );

      await banner.getByRole("button", { name: "Mark not applied" }).click();
      await banner.waitFor({ state: "detached" });
      const done = await until(
        43241,
        id,
        (c) => c.jobs.find((j) => j.text === "/ledger read after resolution")?.status === "done",
      );
      assert.deepEqual(done.toolOutcomesUnknown, []);
      assert.ok(
        done.events.some(
          (e) => e.type === "tool.outcome_resolved" && e.data.outcome === "not-applied",
        ),
      );
      assert.equal(effects(), 1, "the interrupted edit was never re-sent");
      await page2.reload();
      await page2.locator('[contenteditable="true"]').waitFor({ state: "visible" });
      // The first turn's calls are folded again after the reload; open them.
      await page2
        .getByText(/^(Worked for|You stopped after)/)
        .first()
        .click();
      await page2
        .getByText(/^edit: outcome marked not applied$/i)
        .first()
        .waitFor({ state: "visible" });
      await page2.waitForTimeout(300);
      assert.equal(
        await page2.getByRole("alert").filter({ hasText: "Conversation blocked" }).count(),
        0,
      );
      assert.deepEqual(errors, []);
      console.log("PASS unknown outcome shown, blocks work, resolved from the T3 UI");
    } finally {
      await browser?.close();
      for (const port of children.keys()) await stop(port);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
