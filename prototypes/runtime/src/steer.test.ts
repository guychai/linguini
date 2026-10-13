// Handoff rule: a steer is applied only to the run it targeted. A stale steer (target
// finished, interrupted or recovered after restart) is rejected with a typed conflict and
// never becomes a new run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  PostgresStore,
  SqliteStore,
  initial,
  read,
  type Conversation,
  type Store,
} from "./store.ts";
import {
  Engine,
  STEER_TARGET_FINISHED,
  STEER_TARGET_NOT_ACTIVE,
  STEER_TARGET_RECOVERED,
} from "./engine.ts";
import type { Harness, Sink } from "./harness.ts";
import { api } from "./api.ts";

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
/** Runs park until `finish` opens; steering delivery parks until `steered` opens. */
function harnessFactory(
  finish: ReturnType<typeof gate>,
  steered: ReturnType<typeof gate>,
  log: string[],
) {
  return async (): Promise<Harness> => ({
    async run(text: string, _h: string, emit: Sink, signal: AbortSignal) {
      log.push(`run:${text}`);
      await emit("parked", {});
      await Promise.race([
        finish.opened,
        new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
      ]);
      await emit("assistant.delta", { text: `done ${text}` });
    },
    async steer(text: string) {
      log.push(`steer:${text}`);
      await steered.opened;
    },
    async abort() {},
    dispose() {},
  });
}
const noRunFor = (c: Conversation, jobId: string) =>
  !c.events.some((e) => e.type === "run.started" && e.data.jobId === jobId);

for (const kind of ["sqlite", "postgres"] as const) {
  const skip = kind === "postgres" && !database;
  const open = async (dir: string): Promise<Store> =>
    kind === "sqlite" ? new SqliteStore(join(dir, "s.sqlite")) : PostgresStore.open(database!);

  test(
    `${kind}: steer at the final boundary is rejected (STEER_TARGET_FINISHED), never run as a new prompt`,
    { skip, timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "steer-final-")),
        storeA = await open(dir),
        storeB = await open(dir);
      const owner = `steer-${randomUUID()}`,
        id = randomUUID(),
        log: string[] = [];
      const finish = gate(),
        steered = gate();
      const A = new Engine(storeA, harnessFactory(finish, steered, log), {
        heartbeatMs: 0,
        worker: "A",
      });
      const B = new Engine(storeB, harnessFactory(gate(), gate(), log), {
        heartbeatMs: 0,
        worker: "B",
      });
      try {
        await storeA.create(initial(id, owner));
        await A.command(owner, id, { commandId: "run-1", kind: "prompt", text: "first" });
        await until(storeA, owner, id, (c) => c.events.some((e) => e.type === "parked"));
        // Case 1: steer accepted by another worker, still queued when the run finishes.
        assert.deepEqual(
          await B.command(owner, id, {
            commandId: "late-queued",
            kind: "steer",
            text: "too late",
            targetJobId: "run-1",
          }),
          { accepted: true, jobId: "late-queued" },
        );
        // Case 2: steer mid-delivery on the owner (claimed, harness.steer not yet confirmed).
        await A.command(owner, id, {
          commandId: "late-delivering",
          kind: "steer",
          text: "in flight",
          targetJobId: "run-1",
        });
        await until(
          storeA,
          owner,
          id,
          (c) => c.jobs.find((j) => j.id === "late-delivering")?.status === "running",
        );
        finish.open();
        await A.idle(owner, id);
        steered.open();
        const c = await until(
          storeA,
          owner,
          id,
          (c) => c.jobs.find((j) => j.id === "run-1")?.status === "done" && !c.lease,
        );
        await new Promise((r) => setTimeout(r, 30)); // let the parked steer delivery settle
        const after = await read(storeA, owner, id);
        for (const steerId of ["late-queued", "late-delivering"]) {
          assert.equal(after.jobs.find((j) => j.id === steerId)?.status, "rejected", steerId);
          assert.ok(noRunFor(after, steerId), `${steerId} did not start a run`);
          const rejected = after.events.find(
            (e) => e.type === "steering.rejected" && e.data.jobId === steerId,
          );
          assert.equal(rejected?.data.code, STEER_TARGET_FINISHED);
          assert.equal(rejected?.data.target, "run-1");
        }
        assert.deepEqual(
          log.filter((l) => l.startsWith("run:")),
          ["run:first"],
          "exactly one run happened",
        );
        assert.equal(after.events.filter((e) => e.type === "steering.accepted").length, 0);
        assert.equal(c.jobs.filter((j) => j.kind !== "steer").length, 1);
        // A steer for a finished run is refused synchronously with a typed conflict.
        await assert.rejects(
          A.command(owner, id, {
            commandId: "stale",
            kind: "steer",
            text: "x",
            targetJobId: "run-1",
          }),
          (e: { status?: number; code?: string }) =>
            e.status === 409 && e.code === STEER_TARGET_NOT_ACTIVE,
        );
        await assert.rejects(
          A.command(owner, id, { commandId: "none", kind: "steer", text: "x" }),
          (e: { code?: string }) => e.code === STEER_TARGET_NOT_ACTIVE,
        );
        // A steer naming a different run than the active one is refused too.
        const second = gate();
        const C = new Engine(storeA, harnessFactory(second, gate(), log), {
          heartbeatMs: 0,
          worker: "C",
        });
        await C.command(owner, id, { commandId: "run-2", kind: "prompt", text: "second" });
        await until(
          storeA,
          owner,
          id,
          (c) => c.jobs.find((j) => j.id === "run-2")?.status === "running",
        );
        await assert.rejects(
          C.command(owner, id, {
            commandId: "wrong-target",
            kind: "steer",
            text: "x",
            targetJobId: "run-1",
          }),
          (e: { code?: string }) => e.code === STEER_TARGET_NOT_ACTIVE,
        );
        second.open();
        await C.idle(owner, id);
        await C.stop();
      } finally {
        finish.open();
        steered.open();
        await A.stop();
        await B.stop();
        await storeA.close();
        await storeB.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test(
    `${kind}: steer queued for a run that does not survive a restart is rejected (STEER_TARGET_RECOVERED)`,
    { skip, timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "steer-restart-")),
        store = await open(dir),
        other = await open(dir);
      const owner = `steer-r-${randomUUID()}`,
        id = randomUUID(),
        log: string[] = [];
      const A = new Engine(store, harnessFactory(gate(), gate(), log), {
        heartbeatMs: 0,
        worker: "slot",
      });
      const B = new Engine(other, harnessFactory(gate(), gate(), log), {
        heartbeatMs: 0,
        worker: "B",
      });
      try {
        await store.create(initial(id, owner));
        await A.command(owner, id, { commandId: "run-1", kind: "prompt", text: "first" });
        await until(store, owner, id, (c) => c.events.some((e) => e.type === "parked"));
        await A.command(owner, id, { commandId: "next", kind: "queue", text: "queued prompt" });
        await A.stop(); // process goes down: the run is left durably "running"
        // A steer arrives during the restart window; nobody can deliver it.
        await B.command(owner, id, {
          commandId: "pending-steer",
          kind: "steer",
          text: "steer me",
          targetJobId: "run-1",
        });
        const restarted = new Engine(store, harnessFactory(gate(), gate(), log), {
          heartbeatMs: 0,
          worker: "slot",
        });
        try {
          await restarted.recover(owner);
          const c = await until(store, owner, id, (c) =>
            c.events.some((e) => e.type === "parked" && e.data.jobId === "next"),
          );
          assert.equal(c.jobs.find((j) => j.id === "run-1")?.status, "interrupted");
          assert.equal(c.jobs.find((j) => j.id === "pending-steer")?.status, "rejected");
          assert.equal(
            c.events.find((e) => e.type === "steering.rejected")?.data.code,
            STEER_TARGET_RECOVERED,
          );
          assert.ok(noRunFor(c, "pending-steer"), "the stale steer did not become a run");
          assert.deepEqual(
            log.filter((l) => l.startsWith("run:")),
            ["run:first", "run:queued prompt"],
            "the queued prompt still runs",
          );
          assert.ok(
            !log.some((l) => l.startsWith("steer:")),
            "the steer was never delivered to the new run",
          );
        } finally {
          await restarted.stop();
        }
      } finally {
        await A.stop();
        await B.stop();
        await store.close();
        await other.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

test("HTTP: a stale steer returns 409 with a typed code", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "steer-http-")),
    store = new SqliteStore(join(dir, "s.sqlite"));
  const engine = new Engine(store, harnessFactory(gate(), gate(), []), { heartbeatMs: 0 });
  const token = "test-only-steer-token-000000000000000";
  const { server, closeStreams } = api(engine, { [token]: "alice" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await post("/api/conversations", { id: "one" })).status, 201);
    const response = await post("/api/conversations/one/commands", {
      commandId: "s",
      kind: "steer",
      text: "hi",
      targetJobId: "gone",
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, STEER_TARGET_NOT_ACTIVE);
  } finally {
    closeStreams();
    await engine.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
    await rm(dir, { recursive: true });
  }
});
