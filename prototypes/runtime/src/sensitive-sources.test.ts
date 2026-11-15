// V1.1c sensitive-flag sources: the proxy's private-repo marker (read by FileEgressPolicyWriter)
// sets the stored flag before any policy decision; a provider result can carry it too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, initial, read } from "./store.ts";
import {
  SandboxBroker,
  FixtureSandbox,
  type SandboxProvider,
  type ToolCall,
  type ToolResult,
} from "./sandbox.ts";
import { FileEgressPolicyWriter, handsKey } from "./hands.ts";
import { HostToolRegistry } from "./host-tools.ts";

async function tmp(t: { after: (f: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "sensitive-"));
  t.after(() => rm(dir, { recursive: true }));
  return dir;
}

test("FileEgressPolicyWriter.sensitive reads the proxy's marker; no dir or a bad key is false", async (t) => {
  const dir = await tmp(t);
  await mkdir(join(dir, "sensitive"));
  const key = handsKey("alice", "c");
  const writer = new FileEgressPolicyWriter(join(dir, "policies"), join(dir, "sensitive"));
  assert.equal(await writer.sensitive(key), false);
  await writeFile(join(dir, "sensitive", key), '{"reason":"private-repo"}');
  assert.equal(await writer.sensitive(key), true);
  assert.equal(await writer.sensitive("../" + key), false);
  assert.equal(await new FileEgressPolicyWriter(join(dir, "policies")).sensitive(key), false);
});

test("broker: a sensitive source sets the flag (reason private-repo) before the call is decided", async (t) => {
  const dir = await tmp(t);
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(() => store.close());
  await store.create(initial("c", "alice"));
  let marked = false;
  const ran: string[] = [];
  const broker = new SandboxBroker(store, new FixtureSandbox(), {
    sensitiveSource: async (o, i) =>
      marked && o === "alice" && i === "c" ? "private-repo" : undefined,
    hostTools: new HostToolRegistry({
      publish: {
        policy: { replay: "non-idempotent", destination: "sandbox", egress: false },
        writes: ["github"],
        destinations: () => [{ kind: "github", target: "octo/public", crossesBoundary: true }],
        handler: async (call: ToolCall) => {
          ran.push(call.id);
          return { text: "ok" };
        },
      },
    }),
  });
  await broker.execute("alice", "c", {
    id: "w1",
    tool: "write",
    args: { path: "a", content: "x" },
  });
  assert.equal((await read(store, "alice", "c")).tainted, false);
  marked = true;
  await assert.rejects(
    broker.execute("alice", "c", { id: "p1", tool: "publish", args: {} }),
    (e: { code?: string }) => e.code === "sensitive_boundary",
  );
  const c = await read(store, "alice", "c");
  assert.equal(c.tainted, true);
  assert.equal(c.events.find((e) => e.type === "taint.changed")?.data.reason, "private-repo");
  assert.deepEqual(ran, []);
});

test("broker: a provider result marked sensitive commits the flag with the observation", async (t) => {
  const dir = await tmp(t);
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(() => store.close());
  await store.create(initial("c", "alice"));
  const provider: SandboxProvider = {
    kind: "remote",
    provenanceSource: "declared",
    egressBoundary: "proxy",
    allocate: async () => "sb",
    execute: async (): Promise<ToolResult> => ({ text: "cloned", sensitive: "private-repo" }),
  };
  const broker = new SandboxBroker(store, provider);
  await broker.execute("alice", "c", { id: "b1", tool: "bash", args: { command: "git clone" } });
  const c = await read(store, "alice", "c");
  assert.equal(c.tainted, true);
  const taint = c.events.find((e) => e.type === "taint.changed");
  assert.equal(taint?.data.reason, "private-repo");
  // Same commit as the result: the taint event comes right before tool.result.
  const types = c.events.map((e) => e.type);
  assert.equal(types.indexOf("tool.result"), types.indexOf("taint.changed") + 1);
});
