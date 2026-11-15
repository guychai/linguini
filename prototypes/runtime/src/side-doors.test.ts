// "Side doors" that could carry conversation data out of the app: preview sharing routes, guest
// links and link favicons. Preview proxy and CSP checks are in preview.test.ts; egress rule
// validation in egress-rules.test.ts; the external-link click-through page in out.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SqliteStore, initial } from "./store.ts";
import { DEFAULT_TOOL_POLICIES } from "./ledger.ts";
import { Engine } from "./engine.ts";
import { api } from "./api.ts";
import { MemoryPreviewPorts } from "./preview.ts";
import { appCsp } from "./browser-policy.ts";

async function fixture(t: { after: (f: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "side-doors-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true });
  });
  await store.create(initial("a", "alice"));
  return { store };
}

test("share_port is declared egress-capable (unshare_port is not)", () => {
  assert.equal(DEFAULT_TOOL_POLICIES.share_port!.egress, true);
  assert.equal(DEFAULT_TOOL_POLICIES.unshare_port!.egress, false);
});

test("UI preview routes: share, list and unshare (no taint gate); guest links are not served", async (t) => {
  const { store } = await fixture(t);
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
  assert.equal((await call("POST", "/api/conversations/a/previews", { port: 3000 })).status, 200);
  assert.ok(await ports.get("alice", "a", 3000));
  assert.equal((await call("GET", "/api/conversations/a/previews")).status, 200);
  assert.equal((await call("DELETE", "/api/conversations/a/previews/3000")).status, 200);
  assert.equal(
    (await call("POST", "/api/conversations/nope/previews", { port: 3000 })).status,
    404,
  );
  assert.deepEqual(shared, ["share_port a", "unshare_port a"]);
  // D14: upstream T3 guest links are not served by Linguini's backend.
  for (const [method, path] of [
    ["GET", "/api/guest"],
    ["POST", "/api/guest/links"],
    ["GET", "/api/guest/session"],
  ] as const)
    assert.equal((await call(method, path)).status, 404, `${method} ${path}`);
});

test("app CSP keeps link favicons from beaconing (img-src and connect-src stay on our origin)", () => {
  // Upstream's MarkdownLinkFavicon requests https://<link-host>/favicon.ico for every link it
  // renders, a zero-click beacon carrying the host. Only the app CSP stops it today.
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
