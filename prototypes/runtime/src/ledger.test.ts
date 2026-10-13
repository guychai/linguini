// Tool-call ledger: replay classes, intent/observation under the lease epoch, recovery
// after a real SIGKILL at each ledger boundary, and declared-policy taint/publication.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiError,
  PostgresStore,
  SqliteStore,
  StaleOwnerError,
  initial,
  read,
  type Conversation,
  type Store,
} from "./store.ts";
import { SandboxBroker, assertPublicationAllowed, type LedgerBoundary } from "./sandbox.ts";
import { Engine } from "./engine.ts";
import { api, publicConversation } from "./api.ts";
import { DEFAULT_TOOL_POLICIES, executionId, unresolved, type LedgerEntry } from "./ledger.ts";
import {
  FakeDestination,
  LEDGER_CALLS,
  LEDGER_TEST_POLICIES,
  ScriptedHarness,
} from "./ledger-fixtures.ts";

const database = process.env.TEST_DATABASE_URL;
const entries = (c: Conversation): LedgerEntry[] => Object.values(c.ledger ?? {});
const BOUNDARIES: LedgerBoundary[] = [
  "before-intent",
  "after-intent",
  "after-effect",
  "after-observation",
];
const CLASSES = ["safe-read", "idempotent-write", "non-idempotent"] as const;

async function killedChild(env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, "ledger-child.ts")],
    {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  assert.equal(
    signal,
    "SIGKILL",
    `child should be killed at the boundary (code ${code}): ${stderr}`,
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  for (const replay of CLASSES)
    test(
      `${backend}: ${replay} tool killed (SIGKILL) at each ledger boundary recovers by its declared class`,
      { skip: backend === "postgres" && !database, timeout: 90_000 },
      async () => {
        for (const boundary of BOUNDARIES) {
          const dir = await mkdtemp(join(tmpdir(), "ledger-kill-"));
          const storePath = backend === "sqlite" ? join(dir, "state.sqlite") : database!;
          const owner = `ledger-${randomUUID()}`,
            id = `c-${randomUUID()}`;
          const open = async (): Promise<Store> =>
            backend === "sqlite"
              ? new SqliteStore(storePath)
              : PostgresStore.open(storePath, { listen: false });
          let store = await open();
          await store.create(initial(id, owner));
          await store.close();
          await killedChild({
            LEDGER_BACKEND: backend,
            LEDGER_STORE: storePath,
            LEDGER_DEST: join(dir, "destination.sqlite"),
            LEDGER_BOUNDARY: boundary,
            LEDGER_CLASS: replay,
            LEDGER_OWNER: owner,
            LEDGER_CONVERSATION: id,
          });
          // A fresh process: new store, broker and engine; the dead worker's lease expires.
          store = await open();
          store.testClockOffsetMs = 120_000;
          const destination = new FakeDestination(join(dir, "destination.sqlite"));
          const broker = new SandboxBroker(store, destination, { policies: LEDGER_TEST_POLICIES });
          const engine = new Engine(
            store,
            async (o, i, j, fence) =>
              new ScriptedHarness(broker, o, i, j, fence, LEDGER_CALLS["safe-read"]),
            {
              worker: "recovering",
              leaseMs: 60_000,
              heartbeatMs: 0,
              recoverTools: (o, i, fence) => broker.recover(o, i, fence),
            },
          );
          const label = `${replay} @ ${boundary}`;
          try {
            const before = await read(store, owner, id);
            const jobId = before.jobs[0]!.id;
            const call = { id: `${jobId}:call-1`, ...LEDGER_CALLS[replay] };
            const execId = executionId(owner, id, call.id);
            const dispatchesAtKill = destination.count("dispatches");
            const effectsAtKill = destination.count("effects");
            await engine.recover(owner);
            await engine.idle(owner, id);
            const c = await read(store, owner, id);
            assert.equal(c.jobs[0]!.status, "interrupted", label);
            const entry = c.ledger?.[execId];
            const writes = replay === "safe-read" ? 0 : 1;

            if (boundary === "before-intent") {
              // Nothing was recorded and nothing was sent.
              assert.equal(entry, undefined, label);
              assert.equal(destination.count("dispatches"), 0, label);
              // A redelivery of the same call executes it once.
              const result = await broker.execute(owner, id, call);
              assert.match(result.text, /contents|effect/, label);
              assert.equal(destination.count("effects"), writes, label);
              assert.equal(destination.count("dispatches"), 1, label);
              continue;
            }
            assert.ok(entry, label);
            assert.equal(entry.replay, replay, label);
            assert.equal(entry.destination, "sandbox", label);
            assert.match(entry.argsDigest, /^[0-9a-f]{64}$/, label);
            assert.match(entry.policyVersion, /^v1:[0-9a-f]{12}$/, label);
            const intents = c.events.filter(
              (e) => e.type === "tool.intent" && e.data.execId === execId,
            );
            assert.equal(
              intents[0]!.data.epoch,
              1,
              `${label}: first intent under the child's epoch`,
            );

            if (boundary === "after-observation") {
              // Observed before the kill: recovery leaves it alone and redelivery reuses it.
              assert.equal(entry.status, "observed", label);
              assert.equal(entry.attempts, 1, label);
              assert.equal(destination.count("dispatches"), 1, label);
              await broker.execute(owner, id, call);
              assert.equal(destination.count("dispatches"), 1, `${label}: no re-dispatch`);
              assert.equal(destination.count("effects"), writes, label);
              assert.equal(unresolved(c).length, 0, label);
              continue;
            }
            const effectApplied = boundary === "after-effect";
            assert.equal(dispatchesAtKill, effectApplied ? 1 : 0, label);
            assert.equal(effectsAtKill, effectApplied ? writes : 0, label);
            if (replay === "non-idempotent") {
              // Not repeated; surfaced as unknown; further work blocked until resolved.
              assert.equal(entry.status, "unknown", label);
              assert.equal(
                destination.count("dispatches"),
                dispatchesAtKill,
                `${label}: not repeated`,
              );
              assert.equal(destination.count("effects"), effectsAtKill, label);
              assert.deepEqual(
                unresolved(c).map((e) => e.execId),
                [execId],
                label,
              );
              assert.ok(
                c.events.some((e) => e.type === "tool.outcome_unknown"),
                label,
              );
              await assert.rejects(broker.execute(owner, id, call), /outcome unknown/, label);
              await assert.rejects(
                broker.execute(owner, id, { id: "other", tool: "read", args: { path: "x" } }),
                (e: unknown) => e instanceof ApiError && e.code === "tool_outcome_unknown",
              );
              await assert.rejects(
                engine.command(owner, id, { commandId: "pr", kind: "create_pr" }),
                /outcome .* unknown/,
              );
              // New work queues but does not run while blocked.
              await engine.command(owner, id, {
                commandId: "second",
                kind: "prompt",
                text: "next",
              });
              await engine.idle(owner, id);
              let after = await read(store, owner, id);
              const second = after.jobs.find((j) => j.text === "next")!;
              assert.equal(second.status, "queued", label);
              assert.deepEqual(second.blockedOn, [execId], label);
              assert.equal(destination.count("dispatches"), dispatchesAtKill, label);
              // Resolution unblocks it.
              await engine.resolveToolOutcome(
                owner,
                id,
                execId,
                effectApplied ? "applied" : "not-applied",
              );
              await engine.idle(owner, id);
              for (
                let i = 0;
                i < 100 && after.jobs.find((j) => j.text === "next")!.status !== "done";
                i++
              ) {
                await new Promise((r) => setTimeout(r, 20));
                await engine.idle(owner, id);
                after = await read(store, owner, id);
              }
              assert.equal(after.jobs.find((j) => j.text === "next")!.status, "done", label);
              assert.equal(after.ledger![execId]!.status, "resolved", label);
              assert.equal(
                destination.count("effects"),
                effectsAtKill,
                `${label}: still not repeated`,
              );
              continue;
            }
            // Safe reads retry; idempotent writes are re-sent with the same key.
            assert.equal(entry.status, "observed", label);
            assert.equal(entry.attempts, 2, label);
            assert.equal(entry.epoch, 2, `${label}: recovered attempt under the new epoch`);
            assert.equal(destination.count("dispatches"), dispatchesAtKill + 1, label);
            assert.equal(
              destination.count("effects"),
              writes,
              `${label}: exactly one external effect`,
            );
            if (replay === "idempotent-write")
              assert.deepEqual(new Set(destination.keys()), new Set([execId]), `${label}: one key`);
            assert.equal(unresolved(c).length, 0, label);
            assert.ok(c.receipts[`tool:${call.id}`], `${label}: receipt restored`);
          } finally {
            await engine.stop();
            destination.close();
            await store.close();
            await rm(dir, { recursive: true, force: true });
          }
        }
      },
    );
}

async function local(policies = LEDGER_TEST_POLICIES) {
  const dir = await mkdtemp(join(tmpdir(), "ledger-unit-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  const destination = new FakeDestination(join(dir, "destination.sqlite"));
  const owner = "alice",
    id = "one";
  await store.create(initial(id, owner));
  return {
    store,
    destination,
    owner,
    id,
    dir,
    broker: (options: ConstructorParameters<typeof SandboxBroker>[2] = {}) =>
      new SandboxBroker(store, destination, { policies, ...options }),
    close: async () => {
      destination.close();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const simulatedCrash = (at: LedgerBoundary) => (boundary: LedgerBoundary) => {
  if (boundary === at) throw new Error(`crash at ${at}`);
};

function barrier() {
  let release!: () => void;
  let arrived!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (arrived = r));
  return {
    released,
    reached,
    release,
    /** Fault hook: pause the caller at `at` until released. */
    pauseAt: (at: LedgerBoundary) => async (boundary: LedgerBoundary) => {
      if (boundary !== at) return;
      arrived();
      await released;
    },
  };
}
function assertEvidenceOnly(c: Conversation, execId: string, callId: string, label: string) {
  const e = c.ledger![execId]!;
  assert.equal(e.status, "unknown", `${label}: stays unknown`);
  assert.equal(e.observation, undefined, `${label}: no committed result`);
  assert.equal(c.receipts[`tool:${callId}`], undefined, `${label}: no receipt`);
  assert.equal(e.lateObservations?.length, 1, `${label}: kept as evidence`);
  assert.match(e.lateObservations![0]!.result.text, /effect #1/, label);
  assert.ok(
    c.events.some((ev) => ev.type === "tool.late_observation" && ev.data.execId === execId),
  );
  assert.ok(!c.events.some((ev) => ev.type === "tool.result" && ev.data.execId === execId));
  assert.deepEqual(
    unresolved(c).map((u) => u.execId),
    [execId],
    `${label}: still blocking`,
  );
  const listed = publicConversation(c).toolOutcomesUnknown;
  assert.equal(listed[0]!.lateObservations.length, 1, `${label}: evidence visible on the API`);
}

test("gateway path: a late observation after a takeover is evidence only; the outcome stays unknown", async () => {
  const t = await local();
  const engine = new Engine(
    t.store,
    async () => {
      throw new Error("no jobs");
    },
    { worker: "B", leaseMs: 60_000, heartbeatMs: 0 },
  );
  try {
    const gate = barrier();
    const call = { id: "gw", tool: "edit", args: { path: "p", oldText: "a", newText: "b" } };
    // The old caller dispatches, then pauses before committing its observation.
    const late = t.broker({ fault: gate.pauseAt("after-effect") }).execute(t.owner, t.id, call);
    await gate.reached;
    // A new owner takes the lease: the interrupted non-idempotent call becomes unknown.
    await engine.recover(t.owner);
    await engine.idle(t.owner, t.id);
    const execId = executionId(t.owner, t.id, "gw");
    assert.equal((await read(t.store, t.owner, t.id)).ledger![execId]!.status, "unknown");
    // Now the late observation arrives.
    gate.release();
    await assert.rejects(
      late,
      (e: unknown) => e instanceof ApiError && e.code === "tool_observation_late",
    );
    const c = await read(t.store, t.owner, t.id);
    assertEvidenceOnly(c, execId, "gw", "gateway");
    assert.equal(c.ledger![execId]!.lateObservations![0]!.currentEpoch, 1);
    assert.equal(t.destination.count("effects"), 1);
    // Redelivery still refuses; resolution is the only way out.
    await assert.rejects(t.broker().execute(t.owner, t.id, call), /outcome unknown/);
    await engine.resolveToolOutcome(
      t.owner,
      t.id,
      execId,
      "applied",
      "late evidence shows effect #1",
    );
    assert.equal((await read(t.store, t.owner, t.id)).ledger![execId]!.status, "resolved");
  } finally {
    await engine.stop();
    await t.close();
  }
});

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: a paused engine worker that loses its lease cannot commit its late observation`,
    { skip: backend === "postgres" && !database, timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "ledger-late-"));
      const store: Store =
        backend === "sqlite"
          ? new SqliteStore(join(dir, "state.sqlite"))
          : await PostgresStore.open(database!, { listen: false });
      const destination = new FakeDestination(join(dir, "destination.sqlite"));
      const owner = `late-${randomUUID()}`,
        id = `c-${randomUUID()}`;
      const gate = barrier();
      const call = LEDGER_CALLS["non-idempotent"];
      const brokerA = new SandboxBroker(store, destination, {
        policies: DEFAULT_TOOL_POLICIES,
        fault: gate.pauseAt("after-effect"),
      });
      const brokerB = new SandboxBroker(store, destination, { policies: DEFAULT_TOOL_POLICIES });
      const A = new Engine(
        store,
        async (o, i, j, f) => new ScriptedHarness(brokerA, o, i, j, f, call),
        {
          worker: "A",
          leaseMs: 1_000,
          heartbeatMs: 0,
        },
      );
      const B = new Engine(
        store,
        async () => {
          throw new Error("no jobs for B");
        },
        {
          worker: "B",
          leaseMs: 60_000,
          heartbeatMs: 0,
          recoverTools: (o, i, f) => brokerB.recover(o, i, f),
        },
      );
      try {
        await store.create(initial(id, owner));
        await A.command(owner, id, { commandId: "one", kind: "prompt", text: "go" });
        await gate.reached; // A applied the effect and is paused before its observation commit
        store.testClockOffsetMs += 5_000; // A's lease expires on the database clock
        await B.recover(owner);
        await B.idle(owner, id);
        let c = await read(store, owner, id);
        const jobId = c.jobs[0]!.id,
          callId = `${jobId}:call-1`,
          execId = executionId(owner, id, callId);
        assert.equal(c.epoch, 2);
        assert.equal(c.ledger![execId]!.status, "unknown");
        gate.release(); // the late observation arrives under epoch 1
        await A.idle(owner, id);
        c = await read(store, owner, id);
        assertEvidenceOnly(c, execId, callId, backend);
        const evidence = c.ledger![execId]!.lateObservations![0]!;
        assert.deepEqual([evidence.epoch, evidence.currentEpoch, evidence.worker], [1, 2, "A"]);
        assert.equal(c.jobs[0]!.status, "interrupted", "A could not finish the job");
        assert.equal(destination.count("dispatches"), 1);
      } finally {
        gate.release();
        await A.stop();
        await B.stop();
        destination.close();
        await store.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

test("safe reads interrupted repeatedly stop at the retry bound and fail", async () => {
  const t = await local();
  try {
    const crashing = t.broker({ fault: simulatedCrash("after-intent") });
    const call = { id: "r", tool: "read", args: { path: "p" } };
    for (let i = 0; i < 3; i++)
      await assert.rejects(crashing.execute(t.owner, t.id, call), /crash/);
    await assert.rejects(t.broker().execute(t.owner, t.id, call), /retry bound/);
    const e = entries(await read(t.store, t.owner, t.id))[0]!;
    assert.equal(e.status, "failed");
    assert.equal(e.attempts, 3);
    assert.equal(t.destination.count("dispatches"), 0);
  } finally {
    await t.close();
  }
});

test("redelivery without an engine (gateway path): an interrupted non-idempotent call is never re-sent", async () => {
  const t = await local();
  try {
    const call = { id: "e", tool: "edit", args: { path: "p", oldText: "a", newText: "b" } };
    await assert.rejects(
      t.broker({ fault: simulatedCrash("after-effect") }).execute(t.owner, t.id, call),
      /crash/,
    );
    await assert.rejects(t.broker().execute(t.owner, t.id, call), /outcome unknown/);
    await assert.rejects(t.broker().execute(t.owner, t.id, call), /outcome unknown/);
    assert.equal(t.destination.count("dispatches"), 1);
    assert.equal(t.destination.count("effects"), 1);
    assert.equal(unresolved(await read(t.store, t.owner, t.id)).length, 1);
  } finally {
    await t.close();
  }
});

test("taking a lease marks a previous epoch's interrupted non-idempotent call unknown, even without tool recovery", async () => {
  const t = await local();
  const engine = new Engine(
    t.store,
    async (o, i, j, fence) =>
      new ScriptedHarness(t.broker(), o, i, j, fence, LEDGER_CALLS["safe-read"]),
    { worker: "B", leaseMs: 60_000, heartbeatMs: 0 },
  );
  try {
    await t.store.mutate(t.owner, t.id, (s) => {
      s.epoch = 1;
      s.lease = { worker: "A", epoch: 1, until: Number.MAX_SAFE_INTEGER };
    });
    await assert.rejects(
      t
        .broker({ fault: simulatedCrash("after-intent") })
        .execute(t.owner, t.id, { id: "e", tool: "edit", args: {} }, undefined, {
          worker: "A",
          epoch: 1,
        }),
      /crash/,
    );
    // Worker A dies; its lease runs out.
    await t.store.mutate(t.owner, t.id, (s) => {
      s.lease!.until = 0;
    });
    await engine.command(t.owner, t.id, { commandId: "next", kind: "prompt", text: "next" });
    await engine.idle(t.owner, t.id);
    const c = await read(t.store, t.owner, t.id);
    const execId = executionId(t.owner, t.id, "e");
    assert.equal(c.ledger![execId]!.status, "unknown");
    assert.equal(c.epoch, 2);
    assert.equal(c.jobs[0]!.status, "queued");
    assert.deepEqual(c.jobs[0]!.blockedOn, [execId]);
    assert.ok(c.events.some((e) => e.type === "run.blocked"));
    assert.equal(t.destination.count("dispatches"), 0);
  } finally {
    await engine.stop();
    await t.close();
  }
});

test("production policy: write is non-idempotent until the remote honours idempotency keys", async () => {
  assert.equal(DEFAULT_TOOL_POLICIES.write!.replay, "non-idempotent");
  // Sandbox tools stay non-idempotent; only the preview share/unshare (a keyed upsert/delete in
  // Linguini's own database, plus rewriting one env file) is idempotent by construction.
  assert.deepEqual(
    Object.entries(DEFAULT_TOOL_POLICIES)
      .filter(([, p]) => p.replay === "idempotent-write")
      .map(([name]) => name)
      .sort(),
    ["share_port", "unshare_port"],
  );
  const t = await local(DEFAULT_TOOL_POLICIES);
  try {
    const call = { id: "w", tool: "write", args: { path: "p", content: "c" } };
    await assert.rejects(
      t.broker({ fault: simulatedCrash("after-effect") }).execute(t.owner, t.id, call),
      /crash/,
    );
    await assert.rejects(t.broker().execute(t.owner, t.id, call), /outcome unknown/);
    assert.equal(t.destination.count("dispatches"), 1, "not re-sent");
    assert.deepEqual(t.destination.keys(), [null], "no idempotency key is sent for write");
    assert.equal(unresolved(await read(t.store, t.owner, t.id)).length, 1);
  } finally {
    await t.close();
  }
});

test("an intent replays only when its recorded class still matches the declared class", async () => {
  const t = await local();
  try {
    const call = { id: "w", tool: "fixture_put", args: { key: "p", value: "c" } };
    await assert.rejects(
      t.broker({ fault: simulatedCrash("after-effect") }).execute(t.owner, t.id, call),
      /crash/,
    );
    // The declaration changed since the intent: replay is not safe, so the outcome is unknown.
    const changed = new SandboxBroker(t.store, t.destination, {
      policies: {
        ...LEDGER_TEST_POLICIES,
        fixture_put: { replay: "non-idempotent", destination: "sandbox", egress: false },
      },
    });
    assert.notEqual(changed.policyVersion, t.broker().policyVersion);
    await assert.rejects(changed.execute(t.owner, t.id, call), /outcome unknown/);
    assert.equal(t.destination.count("dispatches"), 1);
    assert.equal(entries(await read(t.store, t.owner, t.id))[0]!.status, "unknown");
  } finally {
    await t.close();
  }
});

test("taint and egress blocking follow the declared destination and egress, not tool names", async () => {
  const t = await local({
    // A read-only tool whose destination is production data.
    fetch_customer: { replay: "safe-read", destination: "production", egress: false },
    // An egress-capable tool with an innocuous name.
    notes_sync: { replay: "non-idempotent", destination: "sandbox", egress: true },
    // A tool named "bash" that this table declares as non-egress.
    bash: { replay: "non-idempotent", destination: "sandbox", egress: false },
  });
  try {
    const broker = t.broker();
    await broker.execute(t.owner, t.id, { id: "pre", tool: "notes_sync", args: {} });
    // The destination reports ordinary data and the preflight says ordinary; the
    // declaration alone taints.
    await broker.execute(t.owner, t.id, { id: "q", tool: "fetch_customer", args: { id: 7 } });
    const c = await read(t.store, t.owner, t.id);
    assert.equal(c.tainted, true);
    assert.equal(c.ledger![executionId(t.owner, t.id, "q")]!.destination, "production");
    const dispatched = t.destination.count("dispatches");
    await assert.rejects(
      broker.execute(t.owner, t.id, { id: "s", tool: "notes_sync", args: {} }),
      /"notes_sync" disabled after production-data ingress/,
    );
    await broker.execute(t.owner, t.id, { id: "b", tool: "bash", args: { command: "ls" } });
    assert.equal(t.destination.count("dispatches"), dispatched + 1, "only the non-egress call ran");
    assert.throws(() => assertPublicationAllowed(c), /taint permanently blocks/);
    // Undeclared tools are rejected outright.
    await assert.rejects(
      broker.execute(t.owner, t.id, { id: "u", tool: "read", args: {} }),
      /Invalid tool call/,
    );
  } finally {
    await t.close();
  }
});

test("a stale owner cannot commit an observation; the new owner re-sends the write with the same key", async () => {
  const t = await local();
  try {
    const takeOver = (s: Conversation) => {
      s.epoch = (s.epoch ?? 0) + 1;
      s.lease = { worker: "B", epoch: s.epoch, until: Number.MAX_SAFE_INTEGER };
    };
    await t.store.mutate(t.owner, t.id, (s) => {
      s.epoch = 1;
      s.lease = { worker: "A", epoch: 1, until: Number.MAX_SAFE_INTEGER };
    });
    const call = { id: "w", tool: "fixture_put", args: { key: "p", value: "c" } };
    const stale = t.broker({
      fault: async (at) => {
        if (at === "after-effect") await t.store.mutate(t.owner, t.id, takeOver);
      },
    });
    await assert.rejects(
      stale.execute(t.owner, t.id, call, undefined, { worker: "A", epoch: 1 }),
      StaleOwnerError,
    );
    let e = entries(await read(t.store, t.owner, t.id))[0]!;
    assert.equal(e.status, "intent");
    assert.equal(e.epoch, 1);
    // The stale observation is kept as evidence only.
    assert.equal(e.observation, undefined);
    assert.equal(e.lateObservations?.length, 1);
    assert.equal(e.lateObservations![0]!.worker, "A");
    assert.deepEqual(await t.broker().recover(t.owner, t.id, { worker: "B", epoch: 2 }), [
      e.execId,
    ]);
    e = entries(await read(t.store, t.owner, t.id))[0]!;
    assert.equal(e.status, "observed");
    assert.equal(e.epoch, 2);
    assert.equal(t.destination.count("dispatches"), 2);
    assert.equal(t.destination.count("effects"), 1);
  } finally {
    await t.close();
  }
});

test("definite failures fail; indefinite non-idempotent failures become unknown; cancel before dispatch fails", async () => {
  const t = await local();
  try {
    const broker = t.broker();
    t.destination.failNext = new ApiError(422, "rejected by destination");
    await assert.rejects(
      broker.execute(t.owner, t.id, { id: "a", tool: "edit", args: { n: 1 } }),
      /rejected/,
    );
    t.destination.failNext = new Error("connection reset");
    await assert.rejects(
      broker.execute(t.owner, t.id, { id: "b", tool: "edit", args: { n: 2 } }),
      /reset/,
    );
    let c = await read(t.store, t.owner, t.id);
    assert.equal(c.ledger![executionId(t.owner, t.id, "a")]!.status, "failed");
    assert.equal(c.ledger![executionId(t.owner, t.id, "b")]!.status, "unknown");
    await t.store.mutate(t.owner, t.id, (s) => {
      for (const e of Object.values(s.ledger!)) if (e.status === "unknown") e.status = "resolved";
    });
    const controller = new AbortController();
    const cancelling = t.broker({
      fault: (at) => {
        if (at === "after-intent") controller.abort();
      },
    });
    await assert.rejects(
      cancelling.execute(
        t.owner,
        t.id,
        { id: "c", tool: "edit", args: { n: 3 } },
        controller.signal,
      ),
      /Cancelled before dispatch/,
    );
    c = await read(t.store, t.owner, t.id);
    assert.equal(c.ledger![executionId(t.owner, t.id, "c")]!.status, "failed");
    assert.equal(t.destination.count("dispatches"), 2);
    // A reused call ID with different arguments is refused.
    await assert.rejects(
      broker.execute(t.owner, t.id, { id: "a", tool: "edit", args: { n: 9 } }),
      /different payload/,
    );
  } finally {
    await t.close();
  }
});

test("HTTP: unknown outcomes are listed on the conversation and resolved through the ledger route", async () => {
  const t = await local();
  const engine = new Engine(t.store, async () => {
    throw new Error("no runs in this test");
  });
  const token = "test-only-ledger-token-0000000000000000";
  const { server, closeStreams } = api(engine, { [token]: t.owner });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const call = (path: string, input?: unknown) =>
    fetch(`${origin}${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  try {
    await assert.rejects(
      t
        .broker({ fault: simulatedCrash("after-effect") })
        .execute(t.owner, t.id, { id: "e", tool: "edit", args: {} }),
      /crash/,
    );
    await assert.rejects(
      t.broker().execute(t.owner, t.id, { id: "e", tool: "edit", args: {} }),
      /outcome unknown/,
    );
    const execId = executionId(t.owner, t.id, "e");
    const listed = (await (await call(`/api/conversations/${t.id}`)).json()) as {
      toolOutcomesUnknown: Array<{ execId: string; tool: string }>;
    };
    assert.deepEqual(
      listed.toolOutcomesUnknown.map((u) => [u.execId, u.tool]),
      [[execId, "edit"]],
    );
    const route = `/api/conversations/${t.id}/ledger/${execId}/resolve`;
    assert.equal((await call(route, { outcome: "maybe" })).status, 400);
    assert.equal(
      (
        await call(`/api/conversations/${t.id}/ledger/x${"0".repeat(32)}/resolve`, {
          outcome: "applied",
        })
      ).status,
      404,
    );
    const resolved = await call(route, { outcome: "applied", note: "checked the destination" });
    assert.equal(resolved.status, 200);
    assert.deepEqual(
      ((await resolved.json()) as { toolOutcomesUnknown: unknown[] }).toolOutcomesUnknown,
      [],
    );
    assert.equal((await call(route, { outcome: "applied" })).status, 409);
    const c = await read(t.store, t.owner, t.id);
    assert.deepEqual(c.ledger![execId]!.resolution, {
      outcome: "applied",
      note: "checked the destination",
    });
  } finally {
    closeStreams();
    server.close();
    await engine.stop();
    await t.close();
  }
});
