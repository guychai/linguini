// Q1 loosening: a thread sensitive only from private-repo reads carries taintScope
// "private-repo" into its egress policy (registry GETs stay open at the proxy); any other reason
// makes it fully sensitive for good. Publishing and previews stay blocked either way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { egressTaint } from "./hands.ts";
import { HostToolRegistry } from "./host-tools.ts";
import { assertEgressAllowed } from "./ledger.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import { SqliteStore, initial, markSensitive, read } from "./store.ts";

test("markSensitive: private-repo is narrow; any other reason widens it for good", () => {
  const c = initial("c", "alice");
  assert.equal(markSensitive(c, "private-repo"), true);
  assert.deepEqual([c.tainted, c.taintScope], [true, "private-repo"]);
  assert.equal(markSensitive(c, "private-repo"), false);
  assert.equal(markSensitive(c, "production", { callId: "x" }), true);
  assert.deepEqual([c.tainted, c.taintScope], [true, undefined]);
  assert.equal(markSensitive(c, "private-repo"), false);
  assert.equal(c.taintScope, undefined);
  const d = initial("d", "alice");
  markSensitive(d, "production");
  assert.equal(d.taintScope, undefined);
});

test("egressTaint: policy fields; the proxy marker alone is private-repo scope", () => {
  assert.deepEqual(egressTaint(false, undefined, false), { tainted: false });
  assert.deepEqual(egressTaint(false, undefined, true), {
    tainted: true,
    taintScope: "private-repo",
  });
  assert.deepEqual(egressTaint(true, "private-repo", true), {
    tainted: true,
    taintScope: "private-repo",
  });
  assert.deepEqual(egressTaint(true, undefined, true), { tainted: true });
});

test("broker: private-repo source, then production widens; publication blocked throughout", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "scope-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await store.create(initial("c1", "alice"));
  let marked = true;
  const broker = new SandboxBroker(store, new FixtureSandbox(), {
    sensitiveSource: async () => (marked ? "private-repo" : undefined),
    hostTools: new HostToolRegistry({
      warehouse: {
        policy: { replay: "safe-read", destination: "production", egress: false },
        writes: [],
        destinations: () => [],
        handler: async () => ({ text: "rows", productionData: true }),
      },
    }),
  });
  await broker
    .execute("alice", "c1", { id: "r1", tool: "bash", args: { command: "pwd" } })
    .catch(() => {});
  let c = await read(store, "alice", "c1");
  assert.deepEqual([c.tainted, c.taintScope], [true, "private-repo"]);
  // Publishing outward is still refused on the narrow scope.
  assert.throws(
    () =>
      assertEgressAllowed(
        c,
        { replay: "non-idempotent", destination: "publication", egress: true },
        "github_create_pr",
      ),
    /blocks PR and publication/,
  );
  marked = false;
  await broker
    .execute("alice", "c1", {
      id: "p1",
      tool: "warehouse",
      args: {},
    })
    .catch(() => {});
  c = await read(store, "alice", "c1");
  assert.deepEqual([c.tainted, c.taintScope], [true, undefined]);
  const reasons = c.events.filter((e) => e.type === "taint.changed").map((e) => e.data);
  assert.equal(reasons[0]!.reason, "private-repo");
  assert.equal(reasons.at(-1)!.scope, "full");
});
