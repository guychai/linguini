// V1.0a "side doors": once a conversation has read production data, previews (agent tool, UI
// route) are refused, and other threads' surfaces never show its title. Preview proxy and CSP
// checks are in preview.test.ts; egress rule validation in egress-rules.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SqliteStore, initial, read } from "./store.ts";
import { SandboxBroker, FixtureSandbox } from "./sandbox.ts";
import { DEFAULT_TOOL_POLICIES } from "./ledger.ts";
import { Engine } from "./engine.ts";
import { api, crossThreadConversation, REDACTED_THREAD_TITLE } from "./api.ts";
import { MemoryPreviewPorts } from "./preview.ts";
import { appCsp } from "./browser-policy.ts";

async function tainted(t: { after: (f: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "side-doors-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true });
  });
  await store.create(initial("a", "alice"));
  await store.create(initial("b", "alice"));
  const broker = new SandboxBroker(store, new FixtureSandbox());
  await broker.execute("alice", "a", {
    id: "prod",
    tool: "bash",
    args: { command: "fixture:production-read" },
  });
  assert.equal((await read(store, "alice", "a")).tainted, true);
  return { store, broker };
}

test("P0.1 share_port is declared egress-capable (unshare_port is not)", () => {
  assert.equal(DEFAULT_TOOL_POLICIES.share_port!.egress, true);
  assert.equal(DEFAULT_TOOL_POLICIES.unshare_port!.egress, false);
});

test("A0.1 after fixture:production-read, share_port is 403 with a typed error before dispatch", async (t) => {
  const { store, broker } = await tainted(t);
  const before = (await read(store, "alice", "a")).events.length;
  await assert.rejects(
    broker.execute("alice", "a", { id: "share", tool: "share_port", args: { port: 3000 } }),
    (e: { status?: number; code?: string }) => e.status === 403 && e.code === "egress_tainted",
  );
  const c = await read(store, "alice", "a");
  assert.equal(
    Object.values(c.ledger ?? {}).some((e) => e.tool === "share_port"),
    false,
    "no ledger intent, so nothing was dispatched",
  );
  assert.equal(c.events.length, before);
  // unshare_port is not refused by the egress rule (it only removes access).
  await assert.doesNotReject(
    broker
      .execute("alice", "a", { id: "unshare", tool: "unshare_port", args: { port: 3000 } })
      .catch((e: { code?: string }) => {
        if (e.code === "egress_tainted") throw e;
      }),
  );
});

test("P0.1 UI share route refuses a tainted conversation (403 preview_tainted, no row); list and unshare still work", async (t) => {
  const { store } = await tainted(t);
  const engine = new Engine(store, async () => {
    throw new Error("no runs in this test");
  });
  const ports = new MemoryPreviewPorts();
  const shared: string[] = [];
  const token = "test-only-side-doors-token-00000000000000";
  const { server, closeStreams } = api(engine, { [token]: "alice" }, undefined, {
    previews: {
      ports,
      baseUrl: (id: string) => `https://h/preview/${id}`,
      share: async (o: string, i: string, args: Record<string, unknown>, tool: string) => {
        shared.push(`${tool} ${i}`);
        if (tool === "share_port") await ports.share(o, i, { port: Number(args.port) });
        else await ports.unshare(o, i, Number(args.port));
        return "ok";
      },
    },
  } as never);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    closeStreams();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  const call = (method: string, path: string, input?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  const refused = await call("POST", "/api/conversations/a/previews", { port: 3000 });
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { code?: string }).code, "preview_tainted");
  assert.equal(await ports.get("alice", "a", 3000), null);
  assert.deepEqual(shared, [], "the share handler never ran");
  assert.equal((await call("GET", "/api/conversations/a/previews")).status, 200);
  assert.equal((await call("DELETE", "/api/conversations/a/previews/3000")).status, 200);
  // A clean conversation of the same owner can still share.
  assert.equal((await call("POST", "/api/conversations/b/previews", { port: 3000 })).status, 200);
  assert.deepEqual(shared, ["unshare_port a", "share_port b"]);
  // D14: upstream T3 guest links are not served by Linguini's backend.
  for (const [method, path] of [
    ["GET", "/api/guest"],
    ["POST", "/api/guest/links"],
    ["GET", "/api/guest/session"],
  ] as const)
    assert.equal((await call(method, path)).status, 404, `${method} ${path}`);
});

test("P0.5 a tainted thread's title never appears on another thread's surface", async (t) => {
  const { store } = await tainted(t);
  await store.mutate("alice", "a", (c) => void (c.title = "Q3 churn for customer 4711"));
  await store.mutate("alice", "b", (c) => void (c.title = "Plain thread"));
  const a = await read(store, "alice", "a");
  const b = await read(store, "alice", "b");
  const fromB = crossThreadConversation(a, "b");
  assert.equal(fromB.title, REDACTED_THREAD_TITLE);
  assert.equal(fromB.tainted, true);
  assert.deepEqual(Object.keys(fromB).sort(), ["id", "tainted", "title", "updatedAt"]);
  assert.ok(!JSON.stringify(fromB).includes("4711"));
  // The thread's own surface, and clean threads, keep their titles.
  assert.equal(crossThreadConversation(a, "a").title, "Q3 churn for customer 4711");
  assert.equal(crossThreadConversation(b, "a").title, "Plain thread");
});

test("app CSP keeps link favicons from beaconing (img-src and connect-src stay on our origin)", () => {
  // Upstream's MarkdownLinkFavicon requests https://<link-host>/favicon.ico for every link it
  // renders, a zero-click beacon in a tainted thread. Only the app CSP stops it today.
  for (const csp of [appCsp("t3.example.ts.net", true), appCsp(undefined, false)]) {
    const d = new Map(
      csp.split(";").map((x) => {
        const [name, ...values] = x.trim().split(/\s+/);
        return [name!, values] as const;
      }),
    );
    assert.deepEqual(d.get("img-src"), ["'self'", "data:", "blob:"]);
    assert.deepEqual(d.get("connect-src"), ["'self'"]);
    assert.deepEqual(d.get("default-src"), ["'none'"]);
  }
});
