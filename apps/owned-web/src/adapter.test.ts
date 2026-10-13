import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { OwnedAdapter, mergeEvent, toolLabel } from "./adapter.ts";

const database = process.env.TEST_DATABASE_URL;
test(
  "real backend process: adapter, assets, duplicate commands, SSE reconnect, crash recovery and durable taint",
  { skip: !database, timeout: 30000 },
  async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const token = randomBytes(32).toString("hex"),
      owner = `smoke-${randomUUID()}`;
    const base = "http://127.0.0.1:43222";
    let child: ChildProcess | undefined;
    const start = async () => {
      child = spawn(process.execPath, ["dist/own-main.js"], {
        cwd: `${root}/prototypes/runtime`,
        env: {
          ...process.env,
          DATABASE_URL: database!,
          OWNER_TOKENS: JSON.stringify({ [token]: owner }),
          OWN_PORT: "43222",
          // Each process gets a fresh worker ID, so after the SIGKILL below the replacement
          // recovers only once the dead process's lease expires; keep the lease short.
          OWN_LEASE_MS: "600",
          OWN_WEB_DIST: `${root}/apps/owned-web/dist`,
        },
        stdio: "pipe",
      });
      let errors = "";
      child.stderr?.on("data", (data) => {
        errors += String(data);
      });
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`Backend exited: ${errors}`);
        try {
          if ((await fetch(`${base}/health`)).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("Backend did not start");
    };
    const stop = async (signal: NodeJS.Signals) => {
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill(signal);
        await exited;
      }
    };
    const adapter = new OwnedAdapter(token, fetch, base),
      id = randomUUID();
    const wait = async (
      predicate: (c: Awaited<ReturnType<typeof adapter.snapshot>>) => boolean,
    ) => {
      for (let i = 0; i < 100; i++) {
        const c = await adapter.snapshot(id);
        if (predicate(c)) return c;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error("Conversation did not reach expected state");
    };
    try {
      await start();
      const html = await (await fetch(base)).text();
      assert.match(html, /<title>Linguini<\/title>/);
      const asset = html.match(/src="([^"]+\.js)"/)![1];
      assert.equal((await fetch(base + asset)).status, 200);
      assert.equal((await fetch(base + "/api/session")).status, 401);
      assert.equal((await adapter.session()).owner, owner);
      let current = await adapter.create(id, "Process smoke");
      const controller = new AbortController();
      const seen: number[] = [];
      const streaming = adapter
        .stream(
          id,
          0,
          (e) => {
            seen.push(e.seq);
            current = mergeEvent(current, e);
          },
          controller.signal,
        )
        .catch((e) => {
          if (!controller.signal.aborted) throw e;
        });
      const command = {
        commandId: randomUUID(),
        kind: "prompt" as const,
        text: "/fixture write hello.txt Hello sandbox",
      };
      assert.deepEqual(await adapter.command(id, command), await adapter.command(id, command));
      await wait((c) => c.jobs[0]?.status === "done");
      await new Promise((r) => setTimeout(r, 80));
      controller.abort();
      await streaming;
      assert.equal(new Set(seen).size, seen.length);
      assert.equal(current.jobs.length, 1);
      assert.equal(current.sandboxAllocated, true);
      assert.match(
        toolLabel(current.events.find((e) => e.type === "tool.output")!),
        /write hello.txt/,
      );
      const cursor = seen.at(-1)!;
      await adapter.command(id, { commandId: randomUUID(), kind: "prompt", text: "/fixture wait" });
      await wait((c) => c.events.some((e) => e.type === "fixture.waiting"));
      await adapter.command(id, {
        commandId: randomUUID(),
        kind: "queue",
        text: "/fixture bash fixture:production-read",
      });
      await stop("SIGKILL");
      await start();
      const recovered = await wait((c) => c.tainted && c.jobs.at(-1)?.status === "done");
      assert.equal(recovered.jobs[1]?.status, "interrupted");
      const reconnect = new AbortController(),
        replay: number[] = [];
      const resumed = adapter
        .stream(
          id,
          cursor,
          (e) => {
            replay.push(e.seq);
            if (e.seq === recovered.events.at(-1)!.seq) reconnect.abort();
          },
          reconnect.signal,
        )
        .catch((e) => {
          if (!reconnect.signal.aborted) throw e;
        });
      await resumed;
      assert.deepEqual(
        replay,
        recovered.events.filter((e) => e.seq > cursor).map((e) => e.seq),
      );
      const denied = await fetch(`${base}/api/conversations/${id}/commands`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ commandId: randomUUID(), kind: "publish" }),
      });
      assert.equal(denied.status, 403);
      await stop("SIGTERM");
      await start();
      assert.equal((await adapter.snapshot(id)).tainted, true);
    } finally {
      await stop("SIGTERM");
    }
  },
);

test("adapter list() follows X-Next-Cursor pages until the last page", async () => {
  const pages: Record<string, { body: unknown[]; next?: string }> = {
    "": { body: [{ id: "a" }, { id: "b" }], next: "b" },
    b: { body: [{ id: "c" }, { id: "d" }], next: "d" },
    d: { body: [{ id: "e" }] },
  };
  const requested: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.pathname + url.search);
    const page = pages[url.searchParams.get("cursor") ?? ""]!;
    return new Response(JSON.stringify(page.body), {
      status: 200,
      headers: page.next ? { "x-next-cursor": page.next } : {},
    });
  }) as typeof fetch;
  const adapter = new OwnedAdapter("test-only-token", fakeFetch, "http://owned.invalid");
  assert.deepEqual(
    (await adapter.list(2)).map((c) => c.id),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(requested, [
    "/api/conversations?limit=2",
    "/api/conversations?limit=2&cursor=b",
    "/api/conversations?limit=2&cursor=d",
  ]);
  // A server that repeats its cursor cannot loop the client forever.
  const stuck = (async () =>
    new Response("[]", { status: 200, headers: { "x-next-cursor": "same" } })) as typeof fetch;
  await assert.rejects(
    new OwnedAdapter("t", stuck, "http://owned.invalid").list(),
    /did not advance/,
  );
});
