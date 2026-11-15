// V1.1b host-tool registry: declared write destinations and the sensitive boundary, checked by
// the broker before the ledger intent and again inside it. Host tools run through the ledger on
// any provider (here the fixture), without allocating a sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, initial, read, append } from "./store.ts";
import { SandboxBroker, FixtureSandbox, type ToolCall } from "./sandbox.ts";
import { executionId, unresolved } from "./ledger.ts";
import {
  HostToolRegistry,
  previewHostTools,
  visualHostTools,
  type HostTool,
  type HostToolRun,
} from "./host-tools.ts";

const NON_IDEMPOTENT = { replay: "non-idempotent", destination: "sandbox", egress: false } as const;
const IDEMPOTENT = { replay: "idempotent-write", destination: "sandbox", egress: false } as const;

function publishTool(calls: HostToolRun[], fail?: () => Error): HostTool {
  return {
    policy: NON_IDEMPOTENT,
    writes: ["github"],
    destinations: (call) => [
      { kind: "github", target: String(call.args.repo), crossesBoundary: true },
    ],
    permit: (d) => d.target.startsWith("allowed/"),
    handler: async (_call, run) => {
      calls.push(run);
      if (fail) throw fail();
      return { text: "published" };
    },
  };
}

async function setup(
  t: { after: (f: () => unknown) => void },
  tools: Record<string, HostTool>,
  fault?: ConstructorParameters<typeof SandboxBroker>[2] extends infer O
    ? O extends { fault?: infer F }
      ? F
      : never
    : never,
) {
  const dir = await mkdtemp(join(tmpdir(), "host-tools-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true });
  });
  await store.create(initial("c", "alice"));
  const provider = new FixtureSandbox();
  const broker = new SandboxBroker(store, provider, {
    hostTools: new HostToolRegistry(tools),
    ...(fault ? { fault } : {}),
  });
  const sensitive = () =>
    store.mutate("alice", "c", (s) => {
      s.tainted = true;
      append(s, "taint.changed", { tainted: true, reason: "test" });
    });
  return { store, broker, provider, sensitive };
}

const call = (id: string, tool: string, args: Record<string, unknown>): ToolCall => ({
  id,
  tool,
  args,
});

test("registry: undeclared kind and refused permit are destination_denied; sensitive blocks boundary-crossing only", () => {
  const registry = new HostToolRegistry({
    publish: publishTool([]),
    sneaky: {
      policy: IDEMPOTENT,
      writes: ["conversation-store"],
      destinations: () => [{ kind: "github", target: "x/y", crossesBoundary: true }],
      handler: async () => ({ text: "" }),
    },
    store: {
      policy: IDEMPOTENT,
      writes: ["conversation-store"],
      destinations: () => [{ kind: "conversation-store", target: "r", crossesBoundary: false }],
      handler: async () => ({ text: "" }),
    },
  });
  const ctx = { owner: "alice", conversationId: "c", sensitive: false };
  const code = (f: () => unknown) => {
    try {
      f();
      return "ok";
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  assert.equal(
    code(() => registry.check(call("1", "sneaky", {}), ctx)),
    "destination_denied",
  );
  assert.equal(
    code(() => registry.check(call("1", "publish", { repo: "other/r" }), ctx)),
    "destination_denied",
  );
  assert.equal(
    code(() => registry.check(call("1", "publish", { repo: "allowed/r" }), ctx)),
    "ok",
  );
  const hot = { ...ctx, sensitive: true };
  assert.equal(
    code(() => registry.check(call("1", "publish", { repo: "allowed/r" }), hot)),
    "sensitive_boundary",
  );
  assert.equal(
    code(() => registry.check(call("1", "store", {}), hot)),
    "ok",
  );
  assert.deepEqual(registry.names().sort(), ["publish", "sneaky", "store"]);
});

test("broker: host tool runs through the ledger on the fixture provider without a sandbox", async (t) => {
  const calls: HostToolRun[] = [];
  const { store, broker, provider } = await setup(t, { publish: publishTool(calls) });
  const result = await broker.execute("alice", "c", call("p1", "publish", { repo: "allowed/r" }));
  assert.equal(result.text, "published");
  assert.equal(provider.allocations, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.execId, executionId("alice", "c", "p1"));
  const c = await read(store, "alice", "c");
  assert.equal(c.sandbox, null);
  assert.equal(c.ledger?.[executionId("alice", "c", "p1")]?.status, "observed");
  assert.deepEqual(
    c.events.filter((e) => e.type.startsWith("tool.")).map((e) => e.type),
    ["tool.intent", "tool.result"],
  );
  // A redelivery answers from the ledger, never re-running the handler.
  await broker.execute("alice", "c", call("p1", "publish", { repo: "allowed/r" }));
  assert.equal(calls.length, 1);
});

test("broker: destination_denied and sensitive_boundary refuse before any intent", async (t) => {
  const calls: HostToolRun[] = [];
  const { store, broker, sensitive } = await setup(t, { publish: publishTool(calls) });
  await assert.rejects(
    broker.execute("alice", "c", call("p1", "publish", { repo: "other/r" })),
    (e: { status?: number; code?: string }) => e.status === 403 && e.code === "destination_denied",
  );
  await sensitive();
  await assert.rejects(
    broker.execute("alice", "c", call("p2", "publish", { repo: "allowed/r" })),
    (e: { status?: number; code?: string }) => e.status === 403 && e.code === "sensitive_boundary",
  );
  const c = await read(store, "alice", "c");
  assert.deepEqual(c.ledger ?? {}, {});
  assert.equal(calls.length, 0);
});

test("broker: the flag set after the first check is caught in the intent commit", async (t) => {
  const calls: HostToolRun[] = [];
  let mark: (() => Promise<unknown>) | undefined;
  const { store, broker, sensitive } = await setup(
    t,
    { publish: publishTool(calls) },
    async (boundary) => {
      if (boundary === "before-intent") await mark?.();
    },
  );
  mark = sensitive;
  await assert.rejects(
    broker.execute("alice", "c", call("p1", "publish", { repo: "allowed/r" })),
    (e: { code?: string }) => e.code === "sensitive_boundary",
  );
  assert.deepEqual((await read(store, "alice", "c")).ledger ?? {}, {});
  assert.equal(calls.length, 0);
});

test("broker: a non-idempotent host tool that fails without a definite answer blocks the thread", async (t) => {
  const calls: HostToolRun[] = [];
  const { store, broker } = await setup(t, {
    publish: publishTool(calls, () => new Error("socket hang up")),
    store: {
      policy: IDEMPOTENT,
      writes: [],
      destinations: () => [],
      handler: async () => ({ text: "ok" }),
    },
  });
  await assert.rejects(broker.execute("alice", "c", call("p1", "publish", { repo: "allowed/r" })));
  const c = await read(store, "alice", "c");
  assert.equal(unresolved(c).length, 1);
  await assert.rejects(
    broker.execute("alice", "c", call("s1", "store", {})),
    (e: { code?: string }) => e.code === "tool_outcome_unknown",
  );
});

test("broker: recover() re-sends an interrupted idempotent host write with its key", async (t) => {
  const runs: HostToolRun[] = [];
  let crash = true;
  const { broker } = await setup(
    t,
    {
      store: {
        policy: IDEMPOTENT,
        writes: ["conversation-store"],
        destinations: () => [{ kind: "conversation-store", target: "r", crossesBoundary: false }],
        handler: async (_c, run) => {
          runs.push(run);
          return { text: "stored" };
        },
      },
    },
    (boundary) => {
      if (boundary === "after-intent" && crash) {
        crash = false;
        throw new Error("worker died");
      }
    },
  );
  await assert.rejects(broker.execute("alice", "c", call("s1", "store", {})));
  assert.equal(runs.length, 0);
  assert.deepEqual(await broker.recover("alice", "c"), [executionId("alice", "c", "s1")]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.idempotencyKey, executionId("alice", "c", "s1"));
});

test("previewHostTools / visualHostTools: declared destinations, env refresh, policies", async (t) => {
  const refreshed: string[] = [];
  const preview = previewHostTools({
    tools: async (_o, i, c) => ({ text: `${c.tool} ${i}`, envFile: "" }),
    refreshEnv: async (_o, i) => {
      refreshed.push(i);
      return undefined;
    },
  });
  const visual = visualHostTools({ execute: async () => ({ text: "rendered" }) });
  const { store, broker, sensitive } = await setup(t, { ...preview, ...visual });
  assert.equal(
    (await broker.execute("alice", "c", call("a", "share_port", { port: 3000 }))).text,
    "share_port c",
  );
  assert.deepEqual(refreshed, ["c"]);
  assert.equal(
    (await broker.execute("alice", "c", call("b", "html_render", { html: "<p>" }))).text,
    "rendered",
  );
  await sensitive();
  // share_port is egress-capable (V1.0a), so the egress rule refuses it first.
  await assert.rejects(
    broker.execute("alice", "c", call("c", "share_port", { port: 3001 })),
    (e: { code?: string }) => e.code === "egress_tainted",
  );
  // Removing access and storing a page in the conversation stay allowed.
  await broker.execute("alice", "c", call("d", "unshare_port", { port: 3000 }));
  await broker.execute("alice", "c", call("e", "html_render", { html: "<p>2" }));
  assert.equal((await read(store, "alice", "c")).sandbox, null);
  assert.equal(
    preview.share_port.destinations(call("x", "share_port", { port: 1 }), {
      owner: "alice",
      conversationId: "c",
      sensitive: false,
    })[0]!.crossesBoundary,
    true,
  );
});
