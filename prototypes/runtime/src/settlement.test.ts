// Settle/unsettle is durable, owner-scoped metadata with T3 orchestration-v2 semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SqliteStore, read } from "./store.ts";
import { Engine } from "./engine.ts";
import type { Harness } from "./harness.ts";
import { api } from "./api.ts";

const harness = async (): Promise<Harness> =>
  ({ async run() {}, async steer() {}, async close() {} }) as unknown as Harness;

test("HTTP settle/unsettle: durable, owner-checked, pin promotes, a new message clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "settle-")),
    file = join(dir, "s.sqlite");
  let store = new SqliteStore(file);
  const engine = new Engine(store, harness, { heartbeatMs: 0 });
  const alice = "test-only-settle-token-alice-000000000000",
    bob = "test-only-settle-token-bob-00000000000000";
  const { server, closeStreams } = api(engine, { [alice]: "alice", [bob]: "bob" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = (path: string, body: unknown, token = alice) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const meta = async (body: Record<string, unknown>, token = alice) => {
    const r = await post("/api/conversations/one/metadata", body, token);
    return { status: r.status, m: r.ok ? ((await r.json()) as any).metadata : undefined };
  };
  try {
    assert.equal((await post("/api/conversations", { id: "one" })).status, 201);
    await meta({ commandId: "pin", pinnedAt: "now", pinOrderKey: "g" });
    let r = await meta({ commandId: "s1", settle: "settled" });
    assert.equal(r.status, 200);
    assert.equal(r.m.settledOverride, "settled");
    assert.ok(r.m.settledAt);
    assert.equal(r.m.pinnedAt, null, "settling clears the pin");
    assert.equal(r.m.pinOrderKey, null);
    assert.equal((await meta({ commandId: "x", settle: "maybe" })).status, 400);
    assert.notEqual((await meta({ commandId: "b", settle: "active" }, bob)).status, 200);
    r = await meta({ commandId: "u1", settle: "active" });
    assert.equal(r.m.settledOverride, "active");
    assert.equal(r.m.settledAt, null);
    assert.ok(r.m.unsettledAt);
    await meta({ commandId: "s2", settle: "settled" });
    r = await meta({ commandId: "pin2", pinnedAt: "now" });
    assert.equal(r.m.settledOverride, "active", "pinning promotes a settled thread");
    await meta({ commandId: "s3", settle: "settled" });
    // A new user message returns the thread to automatic settlement.
    assert.equal(
      (
        await post("/api/conversations/one/commands", {
          commandId: "m",
          kind: "prompt",
          text: "hi",
        })
      ).status,
      202,
    );
    closeStreams();
    await engine.stop();
    await store.close();
    store = new SqliteStore(file);
    const c = await read(store, "alice", "one");
    assert.equal(c.metadata?.settledOverride, null);
    assert.equal(c.metadata?.settledAt, null);
    assert.ok(c.metadata?.unsettledAt);
  } finally {
    closeStreams();
    await engine.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
