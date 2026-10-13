// Lab regressions ported to the owned runtime (agent-platform-prototypes tests-local/gaps):
// Stop must not poison later prompts, a model/provider error must not block the conversation,
// request IDs are scoped per conversation and conflict on a different payload, and production
// taint covers every egress-equivalent (bash and publication). Fake harnesses and fake
// sandboxes only; ordering is driven by gates, never by sleeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  ApiError,
  PostgresStore,
  SqliteStore,
  initial,
  read,
  type Conversation,
  type Store,
} from "./store.ts";
import { Engine } from "./engine.ts";
import { FixtureHarness, type Harness, type HarnessFactory, type Sink } from "./harness.ts";
import { FixtureSandbox, SandboxBroker, type SandboxProvider } from "./sandbox.ts";
import { gateway } from "./gateway.ts";
import { issueCapability } from "./capability.ts";

const database = process.env.TEST_DATABASE_URL;
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return { opened, open };
}
async function until(
  store: Store,
  owner: string,
  id: string,
  predicate: (c: Conversation) => boolean,
) {
  for (let i = 0; i < 500; i++) {
    const c = await read(store, owner, id);
    if (predicate(c)) return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}
const status = (c: Conversation, jobId: string) => c.jobs.find((j) => j.id === jobId)?.status;
const completed = (c: Conversation, jobId: string) =>
  c.events.some((e) => e.type === "run.completed" && e.data.jobId === jobId);

/** Scripted harness: per prompt text, park on a gate, throw, ignore abort, or answer. */
function scripted(script: {
  parked?: ReturnType<typeof gate>;
  ignoreAbort?: ReturnType<typeof gate>;
  log: string[];
}): HarnessFactory {
  return async (): Promise<Harness> => ({
    async run(text: string, _h: string, emit: Sink, signal: AbortSignal) {
      script.log.push(text);
      if (text === "factory-throws") throw new Error("unreachable");
      if (text.startsWith("park")) {
        await emit("parked", {});
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          void script.parked?.opened.then(resolve);
        });
      }
      if (text.startsWith("deaf")) {
        // A provider stream that never honours the abort signal.
        await emit("parked", {});
        await script.ignoreAbort!.opened;
      }
      if (text.startsWith("model-error")) {
        await emit("assistant.delta", { text: "partial " });
        throw new Error("400 invalid_request_error: provider rejected the request");
      }
      await emit("assistant.delta", { text: `answer to ${text}` });
    },
    async steer() {},
    async abort() {},
    dispose() {},
  });
}

for (const kind of ["sqlite", "postgres"] as const) {
  const skip = kind === "postgres" && !database;
  const open = async (dir: string): Promise<Store> =>
    kind === "sqlite" ? new SqliteStore(join(dir, "s.sqlite")) : PostgresStore.open(database!);
  const setup = async (factory: HarnessFactory, options = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "regress-")),
      store = await open(dir),
      owner = `regress-${randomUUID()}`,
      id = randomUUID();
    const engine = new Engine(store, factory, { heartbeatMs: 0, ...options });
    await store.create(initial(id, owner));
    return {
      dir,
      store,
      owner,
      id,
      engine,
      async close() {
        await engine.stop();
        await store.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  };

  test(
    `${kind}: Stop does not poison later prompts (mid-run, idle, and across restart)`,
    { skip, timeout: 30_000 },
    async () => {
      const log: string[] = [],
        parked = gate();
      const t = await setup(scripted({ parked, log }));
      try {
        const { engine, store, owner, id } = t;
        await engine.command(owner, id, { commandId: "p1", kind: "prompt", text: "park first" });
        await until(store, owner, id, (c) => c.events.some((e) => e.type === "parked"));
        await engine.command(owner, id, { commandId: "stop-1", kind: "cancel" });
        await engine.idle(owner, id);
        assert.equal(status(await read(store, owner, id), "p1"), "cancelled");
        await engine.command(owner, id, { commandId: "p2", kind: "prompt", text: "after stop" });
        await engine.idle(owner, id);
        let c = await read(store, owner, id);
        assert.ok(completed(c, "p2"), "prompt sent after Stop did not run");
        // Stop while idle is a no-op, not a sticky flag.
        await engine.command(owner, id, { commandId: "stop-2", kind: "cancel" });
        await engine.command(owner, id, {
          commandId: "p3",
          kind: "prompt",
          text: "after idle stop",
        });
        await engine.idle(owner, id);
        c = await read(store, owner, id);
        assert.ok(completed(c, "p3"));
        // A restarted engine does not resurrect the Stop either.
        await engine.stop();
        const restarted = new Engine(store, scripted({ log }), { heartbeatMs: 0 });
        try {
          await restarted.recover(owner);
          await restarted.idle(owner, id);
          await restarted.command(owner, id, {
            commandId: "p4",
            kind: "prompt",
            text: "after restart",
          });
          await restarted.idle(owner, id);
          c = await read(store, owner, id);
          assert.ok(completed(c, "p4"));
          assert.equal(status(c, "p1"), "cancelled");
          assert.deepEqual(log, ["park first", "after stop", "after idle stop", "after restart"]);
        } finally {
          await restarted.stop();
        }
      } finally {
        parked.open();
        await t.close();
      }
    },
  );

  test(
    `${kind}: Stop releases the conversation even when the provider ignores abort`,
    { skip, timeout: 30_000 },
    async () => {
      const log: string[] = [],
        deaf = gate();
      const t = await setup(scripted({ ignoreAbort: deaf, log }), { abortGraceMs: 0 });
      try {
        const { engine, store, owner, id } = t;
        await engine.command(owner, id, { commandId: "d1", kind: "prompt", text: "deaf run" });
        await until(store, owner, id, (c) => c.events.some((e) => e.type === "parked"));
        await engine.command(owner, id, { commandId: "stop", kind: "cancel" });
        await engine.command(owner, id, { commandId: "d2", kind: "prompt", text: "next" });
        // The deaf provider is still blocked (its gate never opens before this assertion).
        const c = await until(store, owner, id, (c) => completed(c, "d2"));
        assert.equal(status(c, "d1"), "cancelled");
        assert.ok(!c.events.some((e) => e.data.jobId === "d1" && e.type === "run.completed"));
        // When the zombie stream finally returns, it cannot write into the conversation.
        const before = (await read(store, owner, id)).events.length;
        deaf.open();
        await engine.idle(owner, id);
        await new Promise((r) => setImmediate(r));
        const after = await read(store, owner, id);
        assert.equal(after.events.filter((e) => e.data.jobId === "d1" && e.seq > before).length, 0);
      } finally {
        deaf.open();
        await t.close();
      }
    },
  );

  test(
    `${kind}: a model error or harness-construction failure does not block the conversation`,
    { skip, timeout: 30_000 },
    async () => {
      const log: string[] = [];
      let failFactory = true;
      const base = scripted({ log });
      const factory: HarnessFactory = async (...args) => {
        if (failFactory) {
          failFactory = false;
          throw new Error("Configured Pi model was not found");
        }
        return base(...args);
      };
      const t = await setup(factory);
      try {
        const { engine, store, owner, id } = t;
        await engine.command(owner, id, { commandId: "f1", kind: "prompt", text: "factory fails" });
        await engine.command(owner, id, {
          commandId: "m1",
          kind: "prompt",
          text: "model-error now",
        });
        await engine.command(owner, id, {
          commandId: "q1",
          kind: "queue",
          text: "queued after error",
        });
        await engine.idle(owner, id);
        let c = await read(store, owner, id);
        assert.equal(status(c, "f1"), "interrupted");
        assert.equal(status(c, "m1"), "interrupted");
        assert.ok(completed(c, "q1"), "queued prompt blocked behind a provider error");
        await engine.command(owner, id, { commandId: "n1", kind: "prompt", text: "fresh prompt" });
        await engine.idle(owner, id);
        c = await read(store, owner, id);
        assert.ok(completed(c, "n1"), "conversation blocked after an ordinary provider error");
        assert.equal(c.lease, null, "lease leaked after a failed run");
      } finally {
        await t.close();
      }
    },
  );

  test(
    `${kind}: request IDs are scoped per conversation and owner; a different payload conflicts`,
    { skip, timeout: 30_000 },
    async () => {
      const log: string[] = [];
      const t = await setup(scripted({ log }));
      // Conversation IDs are globally unique (ownership is checked on every access), so the
      // other owner's conversation has its own ID but reuses the same request ID.
      const other = randomUUID(),
        otherOwner = `regress-other-${randomUUID()}`,
        otherOwners = randomUUID();
      try {
        const { engine, store, owner, id } = t;
        await store.create(initial(other, owner));
        await store.create(initial(otherOwners, otherOwner));
        const shared = randomUUID();
        const a = await engine.command(owner, id, { commandId: shared, kind: "prompt", text: "A" });
        const b = await engine.command(owner, other, {
          commandId: shared,
          kind: "prompt",
          text: "B",
        });
        const o = await engine.command(otherOwner, otherOwners, {
          commandId: shared,
          kind: "prompt",
          text: "O",
        });
        assert.deepEqual([a.jobId, b.jobId, o.jobId], [shared, shared, shared]);
        await Promise.all([
          engine.idle(owner, id),
          engine.idle(owner, other),
          engine.idle(otherOwner, otherOwners),
        ]);
        for (const [who, conv] of [
          [owner, id],
          [owner, other],
          [otherOwner, otherOwners],
        ] as const)
          assert.ok(completed(await read(store, who, conv), shared), `prompt dropped in ${conv}`);
        // The other owner cannot reach this conversation with any ID.
        await assert.rejects(
          engine.command(otherOwner, id, { commandId: "x", kind: "prompt", text: "steal" }),
          (e: unknown) => e instanceof ApiError && e.status === 404,
        );
        // Same ID + same payload is an idempotent replay; same ID + different payload conflicts.
        assert.deepEqual(
          await engine.command(owner, id, { commandId: shared, kind: "prompt", text: "A" }),
          a,
        );
        await assert.rejects(
          engine.command(owner, id, { commandId: shared, kind: "prompt", text: "DIFFERENT" }),
          (e: unknown) => e instanceof ApiError && e.status === 409,
        );
        await assert.rejects(
          engine.command(owner, id, { commandId: shared, kind: "queue", text: "A" }),
          (e: unknown) => e instanceof ApiError && e.status === 409,
        );
        const c = await read(store, owner, id);
        assert.equal(c.jobs.filter((j) => j.id === shared).length, 1);
        assert.deepEqual(log.sort(), ["A", "B", "O"]);
        // Tool-call receipts follow the same rule.
        const broker = new SandboxBroker(store, new FixtureSandbox());
        await broker.execute(owner, id, {
          id: "call",
          tool: "write",
          args: { path: "a.txt", content: "1" },
        });
        await broker.execute(owner, other, {
          id: "call",
          tool: "write",
          args: { path: "a.txt", content: "2" },
        });
        assert.equal((await read(store, owner, other)).files["a.txt"], "2");
        await assert.rejects(
          broker.execute(owner, id, {
            id: "call",
            tool: "write",
            args: { path: "a.txt", content: "X" },
          }),
          (e: unknown) => e instanceof ApiError && e.status === 409,
        );
        assert.equal((await read(store, owner, id)).files["a.txt"], "1");
      } finally {
        await t.close();
      }
    },
  );

  test(
    `${kind}: production taint blocks bash and publication, including within the same turn`,
    { skip, timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "regress-taint-")),
        store = await open(dir),
        owner = `taint-${randomUUID()}`,
        id = randomUUID();
      const broker = new SandboxBroker(store, new FixtureSandbox());
      const engine = new Engine(
        store,
        async (o, i, j, f) => new FixtureHarness(broker, o, i, j, f),
        {
          heartbeatMs: 0,
        },
      );
      try {
        await store.create(initial(id, owner));
        // End to end through the worker: production read, then bash in a later turn.
        await engine.command(owner, id, {
          commandId: "prod",
          kind: "prompt",
          text: "/fixture bash fixture:production-read",
        });
        await engine.command(owner, id, {
          commandId: "egress",
          kind: "queue",
          text: "/fixture bash ls",
        });
        await engine.idle(owner, id);
        let c = await read(store, owner, id);
        assert.equal(c.tainted, true);
        assert.ok(
          !c.events.some((e) => e.type === "tool.result" && e.data.callId === "egress:tool:0"),
        );
        assert.equal(status(c, "egress"), "interrupted");
        for (const kind of ["create_pr", "publish"] as const)
          await assert.rejects(
            engine.command(owner, id, { commandId: kind, kind }),
            (e: unknown) => e instanceof ApiError && e.status === 403,
          );
        await assert.rejects(
          broker.execute(owner, id, { id: "direct", tool: "bash", args: { command: "pwd" } }),
          (e: unknown) => e instanceof ApiError && e.status === 403,
        );
        // The sandbox gateway's publication routes are blocked too.
        const key = "test-only-capability-key-000000000000";
        const server = gateway(broker, key).listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        try {
          for (const route of ["/actions/create-pr", "/actions/publish"]) {
            const response: Response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
              method: "POST",
              headers: { authorization: `Bearer ${issueCapability(key, owner, id)}` },
              body: "{}",
            });
            assert.equal(response.status, 403, route);
          }
          const viaGateway = await fetch(`http://127.0.0.1:${address.port}/tools`, {
            method: "POST",
            headers: { authorization: `Bearer ${issueCapability(key, owner, id)}` },
            body: JSON.stringify({ id: "gw", tool: "bash", args: { command: "pwd" } }),
          });
          assert.equal(viaGateway.status, 403);
        } finally {
          await new Promise<void>((r) => server.close(() => r()));
        }
        c = await read(store, owner, id);
        assert.ok(!c.receipts["tool:direct"] && !c.receipts["tool:gw"]);
      } finally {
        await engine.stop();
        await store.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    `${kind}: remote sandbox: the call that first taints cannot be bash, and unexpected production results taint`,
    { skip, timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "regress-remote-")),
        store = await open(dir),
        owner = `remote-${randomUUID()}`;
      const dispatched: string[] = [];
      const provider: SandboxProvider = {
        kind: "remote",
        allocate: async () => "remote-sandbox",
        classify: async (_s, call) =>
          String(call.args.command ?? call.args.path).includes("prod") ? "production" : "ordinary",
        execute: async (_s, call) => {
          dispatched.push(call.id);
          return { text: "ok", productionData: call.args.path === "sneaky.csv" };
        },
      };
      const broker = new SandboxBroker(store, provider);
      try {
        const first = randomUUID(),
          second = randomUUID();
        await store.create(initial(first, owner));
        await store.create(initial(second, owner));
        // bash classified as production is denied even though it is the tainting call.
        await assert.rejects(
          broker.execute(owner, first, {
            id: "b",
            tool: "bash",
            args: { command: "cat prod.csv" },
          }),
          (e: unknown) => e instanceof ApiError && e.status === 403,
        );
        assert.equal((await read(store, owner, first)).tainted, true);
        assert.deepEqual(dispatched, []);
        // An ordinary-classified read that returns production data taints; later bash is denied.
        await broker.execute(owner, second, {
          id: "r",
          tool: "read",
          args: { path: "sneaky.csv" },
        });
        assert.equal((await read(store, owner, second)).tainted, true);
        await assert.rejects(
          broker.execute(owner, second, { id: "b2", tool: "bash", args: { command: "ls" } }),
          (e: unknown) => e instanceof ApiError && e.status === 403,
        );
        assert.deepEqual(dispatched, ["r"]);
      } finally {
        await store.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

test(
  "an abandoned (disposed) Pi session cannot overwrite the next turn's Pi state",
  { timeout: 20_000 },
  async () => {
    const { PiHarness } = await import("./harness.ts");
    const dir = await mkdtemp(join(tmpdir(), "regress-pi-")),
      store = new SqliteStore(join(dir, "s.sqlite"));
    try {
      await store.create(initial("pi", "alice"));
      const broker = new SandboxBroker(store, new FixtureSandbox());
      const pi = await PiHarness.create(broker, "alice", "pi", join(dir, "host"), "old-job");
      const persist = (pi as unknown as { persist: () => Promise<void> }).persist;
      pi.dispose();
      // A later turn has written its own state.
      await store.mutate("alice", "pi", (c) => {
        c.piEntries = [{ type: "session", marker: "next-turn" } as never];
      });
      await persist();
      const c = await read(store, "alice", "pi");
      assert.deepEqual(c.piEntries, [{ type: "session", marker: "next-turn" }]);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

for (const kind of ["sqlite", "postgres"] as const)
  test(
    `${kind}: a steer the harness consumed at the final boundary is accepted, never rejected for resend`,
    { skip: kind === "postgres" && !database, timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "regress-steer-")),
        store =
          kind === "sqlite"
            ? new SqliteStore(join(dir, "s.sqlite"))
            : await PostgresStore.open(database!),
        owner = `steer-consumed-${randomUUID()}`;
      // The steer itself ends the turn: the harness returns as soon as it receives it, so the
      // run's completion races the steer's confirmation write.
      const factory: HarnessFactory = async () => {
        let release!: () => void;
        const released = new Promise<void>((r) => (release = r));
        return {
          async run(_t: string, _h: string, emit: Sink) {
            await emit("parked", {});
            await released;
          },
          async steer() {
            release();
          },
          async abort() {
            release();
          },
          dispose() {},
        };
      };
      const engine = new Engine(store, factory, { heartbeatMs: 0 });
      try {
        for (let round = 0; round < 10; round++) {
          const id = randomUUID();
          await store.create(initial(id, owner));
          await engine.command(owner, id, { commandId: "run", kind: "prompt", text: "go" });
          await until(store, owner, id, (c) => c.events.some((e) => e.type === "parked"));
          await engine.command(owner, id, {
            commandId: "s",
            kind: "steer",
            text: "wrap up",
            targetJobId: "run",
          });
          const c = await until(store, owner, id, (c) => status(c, "run") === "done" && !c.lease);
          await engine.idle(owner, id);
          const after = await read(store, owner, id);
          assert.equal(status(after, "s"), "done", `round ${round}`);
          assert.ok(
            after.events.some((e) => e.type === "steering.accepted" && e.data.jobId === "s"),
          );
          assert.ok(!after.events.some((e) => e.type === "steering.rejected"), `round ${round}`);
          assert.ok(c);
        }
      } finally {
        await engine.stop();
        await store.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
