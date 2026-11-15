// V1.1a per-conversation egress log: the proxy audit log filtered by the conversation's policy key,
// owner-scoped over the API, only whitelisted fields, bounded tail read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SqliteStore, initial } from "./store.ts";
import { Engine } from "./engine.ts";
import { api } from "./api.ts";
import { handsKey } from "./hands.ts";
import { EgressLog } from "./egress-log.ts";

async function fixture(t: { after: (f: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "egress-log-"));
  t.after(() => rm(dir, { recursive: true }));
  const file = join(dir, "audit.jsonl");
  const a = handsKey("alice", "a");
  const lines = [
    { ts: "t1", event: "dns", sandbox: a, host: "api.test", decision: "allow" },
    {
      ts: "t2",
      event: "request",
      sandbox: a,
      host: "api.test",
      port: 443,
      method: "GET",
      path: "/x",
      decision: "allow",
      status: 200,
      src: "10.0.0.2",
      bytes_in: 5,
      injected: "testsvc",
    },
    {
      ts: "t3",
      event: "request",
      sandbox: a,
      host: "open.test",
      method: "GET",
      path: "[redacted]",
      decision: "deny",
      reason: "secret-detected",
      secret_rule: "github-token",
      open_web: true,
    },
    { ts: "t4", event: "tls", sandbox: a, host: "api.test" },
    {
      ts: "t5",
      event: "request",
      sandbox: handsKey("bob", "a"),
      host: "bob.test",
      decision: "allow",
    },
    {
      ts: "t6",
      event: "request",
      sandbox: handsKey("alice", "b"),
      host: "b.test",
      decision: "allow",
    },
  ];
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json " + a + "\n");
  return { file, dir };
}

test("EgressLog.recent filters to the conversation key and keeps only listed fields", async (t) => {
  const { file } = await fixture(t);
  const log = new EgressLog(file);
  const entries = await log.recent("alice", "a");
  assert.deepEqual(
    entries.map((e) => e.ts),
    ["t1", "t2", "t3"],
  );
  assert.deepEqual(entries[1], {
    ts: "t2",
    event: "request",
    host: "api.test",
    port: 443,
    method: "GET",
    path: "/x",
    decision: "allow",
    status: 200,
  });
  assert.deepEqual(entries[2], {
    ts: "t3",
    event: "request",
    host: "open.test",
    method: "GET",
    path: "[redacted]",
    decision: "deny",
    reason: "secret-detected",
    openWeb: true,
    secretRule: "github-token",
  });
  assert.deepEqual(
    (await log.recent("alice", "a", 1)).map((e) => e.ts),
    ["t3"],
  );
  assert.deepEqual(await new EgressLog(file + ".missing").recent("alice", "a"), []);
});

test("EgressLog reads only the tail and drops the cut line", async (t) => {
  const { file } = await fixture(t);
  const a = handsKey("alice", "a");
  const filler = JSON.stringify({ ts: "old", event: "request", sandbox: a, pad: "x".repeat(400) });
  await appendFile(file, (filler + "\n").repeat(20));
  await appendFile(file, JSON.stringify({ ts: "new", event: "request", sandbox: a }) + "\n");
  const entries = await new EgressLog(file, 1000).recent("alice", "a", 500);
  assert.ok(entries.length >= 1 && entries.length <= 3, String(entries.length));
  assert.equal(entries.at(-1)!.ts, "new");
});

test("GET /api/conversations/:id/egress is owner-scoped; 501 without a log; GET only", async (t) => {
  const { file, dir } = await fixture(t);
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(() => store.close());
  await store.create(initial("a", "alice"));
  const engine = new Engine(store, async () => {
    throw new Error("no runs in this test");
  });
  const aliceToken = "test-only-egress-log-alice-0000000000000000";
  const bobToken = "test-only-egress-log-bob-000000000000000000";
  const start = async (options: object) => {
    const { server, closeStreams } = api(
      engine,
      { [aliceToken]: "alice", [bobToken]: "bob" },
      undefined,
      options as never,
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      closeStreams();
      server.close();
    });
    const port = (server.address() as { port: number }).port;
    return (path: string, token = aliceToken, method = "GET") =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
      });
  };
  const call = await start({ egressLog: new EgressLog(file) });
  const ok = await call("/api/conversations/a/egress?limit=2");
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { entries: { ts: string }[] };
  assert.deepEqual(
    body.entries.map((e) => e.ts),
    ["t2", "t3"],
  );
  // bob has no conversation "a": the snapshot lookup is owner-scoped (404), even though the
  // audit log has entries under bob's own key for that id.
  assert.equal((await call("/api/conversations/a/egress", bobToken)).status, 404);
  assert.equal((await call("/api/conversations/missing/egress")).status, 404);
  assert.equal((await call("/api/conversations/a/egress", aliceToken, "POST")).status, 405);
  const without = await start({});
  assert.equal((await without("/api/conversations/a/egress")).status, 501);
});
