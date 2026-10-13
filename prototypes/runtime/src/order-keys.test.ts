// Pin and Active order keys are separate durable metadata slots behind the HTTP API.
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

test("HTTP metadata: pin/active order keys are separate, durable and idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "order-keys-")),
    file = join(dir, "s.sqlite");
  let store = new SqliteStore(file);
  const engine = new Engine(store, harness, { heartbeatMs: 0 });
  const token = "test-only-order-token-00000000000000000";
  const { server, closeStreams } = api(engine, { [token]: "alice" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("/api/conversations", { id: "one" })).status, 201);
    const meta = (body: Record<string, unknown>) => post("/api/conversations/one/metadata", body);
    assert.equal((await meta({ commandId: "p", pinnedAt: "now", pinOrderKey: "g" })).status, 200);
    const arranged = await meta({ commandId: "a", activeOrderKey: "m" });
    assert.equal(arranged.status, 200);
    const body = (await arranged.json()) as { metadata: Record<string, unknown> };
    assert.equal(body.metadata.pinOrderKey, "g");
    assert.equal(body.metadata.activeOrderKey, "m");
    assert.equal((await meta({ commandId: "r", pinOrderKey: "c" })).status, 200);
    // Same command ID with a different payload is a conflict and changes nothing.
    assert.equal((await meta({ commandId: "r", pinOrderKey: "x" })).status, 409);
    assert.equal((await meta({ commandId: "r", pinOrderKey: "c" })).status, 200);
    assert.equal((await meta({ commandId: "bad", sortKey: "c" })).status, 403);
    closeStreams();
    await engine.stop();
    await store.close();
    store = new SqliteStore(file);
    const c = await read(store, "alice", "one");
    assert.equal(c.metadata?.pinOrderKey, "c");
    assert.equal(c.metadata?.activeOrderKey, "m");
    assert.equal(c.metadata?.orderKey, undefined);
  } finally {
    closeStreams();
    await engine.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
