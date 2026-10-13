// Ownership and fencing: per-conversation leases with monotonic epochs and an
// append-only journal. Races are driven with explicit gates and the database clock (advanced through a store test seam).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  PostgresStore,
  SqliteStore,
  StaleOwnerError,
  append,
  dbNow,
  initial,
  read,
  type Conversation,
  type Fence,
  type Store,
} from "./store.ts";
import { Engine } from "./engine.ts";
import { FixtureHarness, type Harness, type Sink } from "./harness.ts";
import { FixtureSandbox, SandboxBroker, type SandboxProvider, type ToolCall } from "./sandbox.ts";

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
  for (let i = 0; i < 400; i++) {
    const c = await read(store, owner, id);
    if (predicate(c)) return c;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}
/** Harness that parks at a gate, then performs a tool write through the broker and emits output. */
class GatedHarness implements Harness {
  constructor(
    private broker: SandboxBroker,
    private owner: string,
    private id: string,
    private jobId: string,
    private fence: Fence | undefined,
    private parked: ReturnType<typeof gate>,
    private onResult: (outcome: unknown) => void,
  ) {}
  async run(text: string, _history: string, emit: Sink, signal: AbortSignal) {
    await emit("gated.waiting", {});
    await this.parked.opened; // deliberately ignores abort: models a paused (GC/VM-stalled) process
    try {
      const call: ToolCall = {
        id: `${this.jobId}:tool:0`,
        tool: "write",
        args: { path: "stale.txt", content: text },
      };
      this.onResult(await this.broker.execute(this.owner, this.id, call, undefined, this.fence));
    } catch (error) {
      this.onResult(error);
      throw error;
    }
    await emit("assistant.delta", { text: "late output" });
    signal.throwIfAborted();
  }
  async steer() {}
  async abort() {}
  dispose() {}
}
type Backend = { open: () => Promise<Store>; cleanup: () => Promise<void>; dir: string };
async function backend(kind: "sqlite" | "postgres"): Promise<Backend> {
  const dir = await mkdtemp(join(tmpdir(), "owned-lease-"));
  return {
    dir,
    open: async () =>
      kind === "sqlite"
        ? new SqliteStore(join(dir, "state.sqlite"))
        : PostgresStore.open(database!),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

for (const kind of ["sqlite", "postgres"] as const) {
  const skip = kind === "postgres" && !database;

  test(
    `${kind}: two workers contend for one conversation; exactly one acquires and runs it`,
    { skip, timeout: 20_000 },
    async () => {
      const b = await backend(kind),
        storeA = await b.open(),
        storeB = await b.open();
      const owner = `contend-${randomUUID()}`,
        id = randomUUID();
      const parked = gate();
      let factories = 0;
      const make = (store: Store, worker: string) => {
        const broker = new SandboxBroker(store, new FixtureSandbox());
        return new Engine(
          store,
          async (o, i, j, fence) => {
            factories++;
            return new GatedHarness(broker, o, i, j, fence, parked, () => undefined);
          },
          { worker, heartbeatMs: 0, leaseMs: 1000 },
        );
      };
      const A = make(storeA, "A"),
        B = make(storeB, "B");
      try {
        await storeA.create(initial(id, owner));
        await storeA.mutate(owner, id, (c) => {
          c.jobs.push({ id: "job", text: "contended", status: "queued", kind: "prompt" });
          append(c, "run.queued", { jobId: "job" });
        });
        await Promise.all([A.recover(owner), B.recover(owner), A.recover(owner), B.recover(owner)]);
        const c = await until(storeA, owner, id, (c) =>
          c.events.some((e) => e.type === "gated.waiting"),
        );
        assert.equal(factories, 1, "only one worker creates a harness");
        assert.equal(c.epoch, 1);
        const holder = c.lease!.worker;
        assert.ok(holder === "A" || holder === "B");
        // The non-holder cannot steal a live lease, even when asked repeatedly.
        await (holder === "A" ? B : A).sweep(owner);
        await (holder === "A" ? B : A).recover(owner);
        await (holder === "A" ? B : A).idle(owner, id);
        assert.equal((await read(storeA, owner, id)).lease?.worker, holder);
        assert.equal((await read(storeA, owner, id)).epoch, 1);
        parked.open();
        await until(storeA, owner, id, (c) => c.jobs[0]?.status === "done" && !c.lease);
        assert.equal(factories, 1);
      } finally {
        parked.open();
        await A.stop();
        await B.stop();
        await storeA.close();
        await storeB.close();
        await b.cleanup();
      }
    },
  );

  test(
    `${kind}: takeover after lease expiry bumps the epoch; a paused old owner cannot commit or dispatch`,
    { skip, timeout: 20_000 },
    async () => {
      const b = await backend(kind),
        storeA = await b.open(),
        storeB = await b.open();
      const owner = `takeover-${randomUUID()}`,
        id = randomUUID();
      // Time passes on the database clock (both workers share the database).
      const advance = (ms: number) => {
        storeA.testClockOffsetMs += ms;
        storeB.testClockOffsetMs += ms;
      };
      let dispatches = 0;
      // A remote-style provider: counts real dispatches so a stale dispatch is observable.
      const remote: SandboxProvider = {
        kind: "remote",
        allocate: async () => "remote-sandbox",
        classify: async () => "ordinary",
        execute: async () => {
          dispatches++;
          return { text: "dispatched", productionData: false };
        },
      };
      const parkedA = gate(),
        parkedB = gate();
      const outcomes: unknown[] = [];
      const A = new Engine(
        storeA,
        async (o, i, j, fence) =>
          new GatedHarness(new SandboxBroker(storeA, remote), o, i, j, fence, parkedA, (r) =>
            outcomes.push(r),
          ),
        { worker: "A", heartbeatMs: 0, leaseMs: 1000 },
      );
      const B = new Engine(
        storeB,
        async (o, i, j, fence) =>
          new GatedHarness(
            new SandboxBroker(storeB, remote),
            o,
            i,
            j,
            fence,
            parkedB,
            () => undefined,
          ),
        { worker: "B", heartbeatMs: 0, leaseMs: 1000 },
      );
      try {
        await storeA.create(initial(id, owner));
        await A.command(owner, id, { commandId: "first", kind: "prompt", text: "from-A" });
        await until(storeA, owner, id, (c) =>
          c.events.some((e) => e.type === "gated.waiting" && e.data.jobId === "first"),
        );
        assert.equal((await read(storeA, owner, id)).lease?.epoch, 1);
        // Renewal keeps ownership while A is healthy.
        advance(900);
        assert.equal(await A.heartbeat(owner, id), true);
        advance(900);
        await B.sweep(owner);
        await B.idle(owner, id);
        assert.equal(
          (await read(storeA, owner, id)).lease?.worker,
          "A",
          "renewed lease is not stolen",
        );
        // A pauses (no heartbeats); its lease expires and B takes over.
        advance(1001);
        await B.sweep(owner);
        await B.idle(owner, id);
        const taken = await until(storeA, owner, id, (c) => c.epoch === 2);
        assert.notEqual(taken.lease?.worker, "A", "A no longer owns the conversation");
        assert.equal(taken.jobs.find((j) => j.id === "first")?.status, "interrupted");
        assert.match(
          String(taken.events.find((e) => e.type === "run.interrupted")?.data.reason),
          /lost its lease/,
        );
        const before = await read(storeA, owner, id);
        // A wakes up and tries to dispatch a tool and stream output with its stale epoch.
        parkedA.open();
        await A.idle(owner, id);
        assert.ok(outcomes[0] instanceof StaleOwnerError, "stale tool dispatch is rejected");
        assert.equal(dispatches, 0, "nothing was dispatched by the stale owner");
        assert.equal(await A.heartbeat(owner, id), false);
        const after = await read(storeA, owner, id);
        assert.equal(after.lastSeq, before.lastSeq, "the stale owner committed no journal entries");
        assert.deepEqual(after.receipts, before.receipts);
        assert.equal(after.jobs.find((j) => j.id === "first")?.status, "interrupted");
        assert.equal(after.epoch, 2);
        assert.notEqual(after.lease?.worker, "A");
        // The new owner keeps working normally.
        await B.command(owner, id, { commandId: "second", kind: "prompt", text: "from-B" });
        await until(storeB, owner, id, (c) =>
          c.events.some((e) => e.type === "gated.waiting" && e.data.jobId === "second"),
        );
        parkedB.open();
        const done = await until(
          storeB,
          owner,
          id,
          (c) => c.jobs.find((j) => j.id === "second")?.status === "done",
        );
        assert.equal(dispatches, 1);
        assert.equal(done.epoch, 3, "every acquisition gets a fresh epoch");
        assert.equal(
          done.files["stale.txt"],
          undefined,
          "remote writes do not touch fixture files",
        );
      } finally {
        parkedA.open();
        parkedB.open();
        await A.stop();
        await B.stop();
        await storeA.close();
        await storeB.close();
        await b.cleanup();
      }
    },
  );

  test(
    `${kind}: cancellation issued on another worker reaches the lease holder`,
    { skip, timeout: 20_000 },
    async () => {
      const b = await backend(kind),
        storeA = await b.open(),
        storeB = await b.open();
      const owner = `xcancel-${randomUUID()}`,
        id = randomUUID();
      let aborted = 0;
      const waiting = (store: Store) =>
        new Engine(
          store,
          async () => ({
            async run(_t: string, _h: string, emit: Sink, signal: AbortSignal) {
              await emit("w", {});
              await new Promise<void>((_r, reject) =>
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted++;
                    reject(new Error("aborted"));
                  },
                  { once: true },
                ),
              );
            },
            async steer() {},
            async abort() {},
            dispose() {},
          }),
          { heartbeatMs: 0 },
        );
      const A = waiting(storeA),
        B = waiting(storeB);
      try {
        await storeA.create(initial(id, owner));
        await A.command(owner, id, { commandId: "run", kind: "prompt", text: "wait" });
        await until(storeA, owner, id, (c) => c.events.some((e) => e.type === "w"));
        await B.command(owner, id, { commandId: "stop", kind: "cancel" });
        await A.heartbeat(owner, id); // deterministic stand-in for the timer / change notification
        await A.idle(owner, id);
        assert.equal(aborted, 1);
        const c = await read(storeA, owner, id);
        assert.equal(c.jobs[0]?.status, "cancelled");
        assert.equal(c.lease, null, "lease released after the run ends");
      } finally {
        await A.stop();
        await B.stop();
        await storeA.close();
        await storeB.close();
        await b.cleanup();
      }
    },
  );

  test(
    `${kind}: concurrent writers on two workers produce a gapless journal; snapshot + replay converges`,
    { skip, timeout: 20_000 },
    async () => {
      const b = await backend(kind),
        storeA = await b.open(),
        storeB = await b.open();
      const owner = `journal-${randomUUID()}`,
        id = randomUUID();
      try {
        await storeA.create(initial(id, owner));
        const write = (store: Store, n: number) =>
          store.mutate(owner, id, (c) => {
            append(c, "test.append", { n });
          });
        const first = Array.from({ length: 20 }, (_, n) => write(n % 2 ? storeA : storeB, n));
        await Promise.all(first.slice(0, 10));
        const snapshot = await read(storeB, owner, id);
        await Promise.all(first);
        await Promise.all(
          Array.from({ length: 20 }, (_, n) => write(n % 2 ? storeB : storeA, 20 + n)),
        );
        const replay = await storeA.events(owner, id, snapshot.lastSeq ?? 0);
        const final = await read(storeA, owner, id);
        assert.deepEqual(
          final.events.map((e) => e.seq),
          Array.from({ length: 40 }, (_, i) => i + 1),
          "contiguous per-conversation sequence",
        );
        assert.deepEqual(
          [...snapshot.events, ...replay],
          final.events,
          "snapshot + replay == final journal",
        );
        assert.equal(
          snapshot.events.length,
          snapshot.lastSeq,
          "snapshot is an internally consistent prefix",
        );
        assert.deepEqual(new Set(final.events.map((e) => e.data.n)).size, 40);
        // Mutations without { events: true } cannot read history by accident.
        await assert.rejects(
          storeA.mutate(owner, id, (c) => c.events.length),
          /Journal not loaded/,
        );
      } finally {
        await storeA.close();
        await storeB.close();
        await b.cleanup();
      }
    },
  );
  test(
    `${kind}: a restarted worker slot reclaims its own lease at once; other workers wait for expiry`,
    { skip, timeout: 20_000 },
    async () => {
      const b = await backend(kind),
        store = await b.open();
      const owner = `slot-${randomUUID()}`,
        id = randomUUID();
      const fixture = (worker: string) =>
        new Engine(
          store,
          async (o, i, j, fence) =>
            new FixtureHarness(new SandboxBroker(store, new FixtureSandbox()), o, i, j, fence),
          { worker, heartbeatMs: 0, leaseMs: 1000 },
        );
      const other = fixture("other"),
        restarted = fixture("slot-1");
      try {
        await store.create(initial(id, owner));
        // State left behind by a crashed "slot-1" process: live lease, a running and a queued job.
        await store.mutate(owner, id, (c) => {
          c.epoch = 4;
          c.lease = { worker: "slot-1", epoch: 4, until: dbNow(c) + 60_000 };
          c.jobs.push(
            { id: "was-running", text: "x", status: "running", kind: "prompt" },
            { id: "queued", text: "/fixture write a.txt ok", status: "queued", kind: "prompt" },
          );
        });
        await other.recover(owner);
        await other.idle(owner, id);
        assert.equal(
          (await read(store, owner, id)).epoch,
          4,
          "a different worker cannot take a live lease",
        );
        await restarted.recover(owner);
        await restarted.idle(owner, id);
        const c = await until(
          store,
          owner,
          id,
          (c) => c.jobs.find((j) => j.id === "queued")?.status === "done",
        );
        assert.equal(c.epoch, 5);
        assert.equal(c.jobs.find((j) => j.id === "was-running")?.status, "interrupted");
        assert.match(
          String(c.events.find((e) => e.type === "run.interrupted")?.data.reason),
          /Worker restart/,
        );
        assert.equal(c.files["a.txt"], "ok");
      } finally {
        await other.stop();
        await restarted.stop();
        await store.close();
        await b.cleanup();
      }
    },
  );
}

test(
  "sqlite: v1 rows with an embedded journal migrate to the append-only events table",
  { timeout: 20_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "owned-migrate-")),
      path = join(dir, "state.sqlite");
    try {
      const legacy = initial("legacy", "alice") as Partial<Conversation> & Conversation;
      delete legacy.lastSeq;
      delete legacy.epoch;
      delete legacy.lease;
      legacy.events = [
        { seq: 1, type: "message.user", data: { jobId: "j", text: "hi" } },
        { seq: 2, type: "run.completed", data: { jobId: "j" } },
      ];
      const raw = new DatabaseSync(path);
      raw.exec(
        "CREATE TABLE conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL)",
      );
      raw
        .prepare("INSERT INTO conversations VALUES (?,?,?)")
        .run("legacy", "alice", JSON.stringify(legacy));
      raw.close();
      const store = new SqliteStore(path);
      try {
        const c = await read(store, "alice", "legacy");
        assert.deepEqual(
          c.events.map((e) => e.seq),
          [1, 2],
        );
        assert.equal(c.lastSeq, 2);
        await store.mutate("alice", "legacy", (c) => {
          append(c, "after.migration", {});
        });
        assert.deepEqual(
          (await read(store, "alice", "legacy")).events.map((e) => e.seq),
          [1, 2, 3],
        );
      } finally {
        await store.close();
      }
      const check = new DatabaseSync(path);
      const state = JSON.parse(
        (check.prepare("SELECT state FROM conversations").get() as { state: string }).state,
      );
      assert.equal(state.events, undefined, "the row no longer carries the journal");
      assert.throws(() => check.exec("UPDATE conversation_events SET type='x'"), /append-only/);
      check.close();
      // Re-opening is idempotent.
      const again = new SqliteStore(path);
      assert.equal((await read(again, "alice", "legacy")).events.length, 3);
      await again.close();
    } finally {
      await rm(dir, { recursive: true });
    }
  },
);

test(
  "postgres: v1 rows with an embedded journal migrate to the append-only events table",
  { skip: !database, timeout: 20_000 },
  async () => {
    const pool = new Pool({ connectionString: database });
    const id = `legacy-${randomUUID()}`;
    try {
      await (await PostgresStore.open(database!, { listen: false })).close(); // ensure schema exists
      const legacy = {
        ...initial(id, "alice"),
        events: [
          { seq: 1, type: "message.user", data: { text: "hi" } },
          { seq: 2, type: "run.completed", data: {} },
        ],
      } as Record<string, unknown>;
      delete legacy.lastSeq;
      delete legacy.epoch;
      delete legacy.lease;
      await pool.query("INSERT INTO prototype_conversations VALUES ($1,'alice',$2)", [
        id,
        JSON.stringify(legacy),
      ]);
      const store = await PostgresStore.open(database!, { listen: false });
      try {
        const c = await read(store, "alice", id);
        assert.deepEqual(
          c.events.map((e) => e.seq),
          [1, 2],
        );
        assert.equal(c.lastSeq, 2);
        await store.mutate("alice", id, (c) => {
          append(c, "after.migration", {});
        });
        assert.deepEqual(
          (await read(store, "alice", id)).events.map((e) => e.seq),
          [1, 2, 3],
        );
      } finally {
        await store.close();
      }
      const row = await pool.query(
        "SELECT state ? 'events' AS has FROM prototype_conversations WHERE id=$1",
        [id],
      );
      assert.equal(row.rows[0].has, false);
      await assert.rejects(
        pool.query("UPDATE prototype_events SET type='x' WHERE conversation_id=$1", [id]),
        /append-only/,
      );
    } finally {
      await pool.end();
    }
  },
);

for (const kind of ["sqlite", "postgres"] as const)
  test(
    `${kind}: lease timing follows the database clock, so worker clock skew cannot steal or expire a lease`,
    { skip: kind === "postgres" && !process.env.TEST_DATABASE_URL, timeout: 20_000 },
    async () => {
      const b = await backend(kind),
        storeA = await b.open(),
        storeB = await b.open();
      const owner = `skew-${randomUUID()}`,
        id = randomUUID();
      const realNow = Date.now;
      const skew = (ms: number) => {
        Date.now = () => realNow() + ms;
      };
      const parked = gate();
      const make = (store: Store, worker: string) =>
        new Engine(
          store,
          async (o, i, j, fence) =>
            new GatedHarness(
              new SandboxBroker(store, new FixtureSandbox()),
              o,
              i,
              j,
              fence,
              parked,
              () => undefined,
            ),
          { worker, heartbeatMs: 0, leaseMs: 1000 },
        );
      const A = make(storeA, "A"),
        B = make(storeB, "B");
      try {
        await storeA.create(initial(id, owner));
        await A.command(owner, id, { commandId: "run", kind: "prompt", text: "skewed" });
        await until(storeA, owner, id, (c) => c.events.some((e) => e.type === "gated.waiting"));
        // B's host clock runs an hour fast: with app-clock leases it would see A's lease as
        // long expired and take over. The database says the lease is live.
        skew(60 * 60_000);
        await B.sweep(owner);
        await B.recover(owner);
        await B.idle(owner, id);
        let c = await read(storeA, owner, id);
        assert.equal(c.lease?.worker, "A", "a fast worker clock must not steal a live lease");
        assert.equal(c.epoch, 1);
        // A's host clock runs an hour slow: an app-clock renewal would write an already
        // expired deadline. The renewal is relative to the database clock instead.
        skew(-60 * 60_000);
        assert.equal(await A.heartbeat(owner, id), true);
        c = await read(storeA, owner, id);
        assert.ok(c.lease!.until > dbNow(c), "renewed lease is live on the database clock");
        assert.ok(c.lease!.until <= dbNow(c) + 1000);
        // Real expiry is measured on the database clock, whatever the workers think.
        Date.now = realNow;
        storeA.testClockOffsetMs += 1001;
        storeB.testClockOffsetMs += 1001;
        skew(-60 * 60_000); // B's slow clock does not delay the takeover either
        await B.sweep(owner);
        await B.idle(owner, id);
        c = await until(storeA, owner, id, (c) => c.epoch === 2);
        assert.notEqual(c.lease?.worker, "A");
        assert.equal(await A.heartbeat(owner, id), false, "A is fenced out");
      } finally {
        Date.now = realNow;
        parked.open();
        await A.stop();
        await B.stop();
        await storeA.close();
        await storeB.close();
        await b.cleanup();
      }
    },
  );
