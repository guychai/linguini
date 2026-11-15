// SPIKE tests: pi-durable 1.5.2 storage conformance on PostgresLogStorage, plus replay, lease
// fencing and unknown-outcome reload. Needs DATABASE_URL (throwaway local Postgres).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { commitWrites, createStorageConformance } from "@earendil-works/pi-durable/testing";
import { PostgresLogPoisonedError, PostgresLogStorage } from "./durable-pg.ts";

const url = process.env.DATABASE_URL;
const strip = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(strip)
    : v && typeof v === "object" && !(v instanceof Map) && !(v instanceof Set)
      ? Object.fromEntries(
          Object.entries(v as object)
            .filter(([, x]) => x !== undefined)
            .map(([k, x]) => [k, strip(x)]),
        )
      : v;
const assertions = {
  ok: (v: unknown, m?: string) => assert.ok(v, m),
  strictEqual: (a: unknown, b: unknown) => assert.strictEqual(a, b),
  deepEqual: (a: unknown, b: unknown) => assert.deepStrictEqual(strip(a), strip(b)),
  partialDeepEqual: (a: unknown, b: unknown) => assert.partialDeepStrictEqual(a, b),
  greaterThan: (a: number, b: number) => assert.ok(a > b, `${a} > ${b}`),
  rejects: async (op: Promise<unknown>, msg: string) => {
    await assert.rejects(op, (e: Error) => String(e?.message ?? e).includes(msg));
  },
};
const internals = (s: PostgresLogStorage) =>
  (s as unknown as { memory: { state: unknown; nextId: number; nextSeq: number } }).memory;

describe("baseline: MemoryStorage passes the suite with these assertions", () => {
  for (const c of createStorageConformance({
    assertions,
    withStorage: async (use) => use(new MemoryStorage()),
  }))
    it(c.name, () => c.run());
});

describe("PostgresLogStorage", { skip: !url }, () => {
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  before(async () => {
    await PostgresLogStorage.ensureSchema(pool);
    await pool.query(
      "CREATE TABLE IF NOT EXISTS spike_lease (key text PRIMARY KEY, epoch int NOT NULL)",
    );
  });
  after(() => pool.end());

  describe("conformance", () => {
    for (const c of createStorageConformance({
      assertions,
      withStorage: async (use) => use(await PostgresLogStorage.open(pool, randomUUID())),
    }))
      it(c.name, () => c.run());
  });

  describe("conformance + replay: reopening the log reproduces memory exactly", () => {
    for (const c of createStorageConformance({
      assertions,
      withStorage: async (use) => {
        const key = randomUUID();
        const s = await PostgresLogStorage.open(pool, key);
        await use(s);
        const r = await PostgresLogStorage.open(pool, key);
        const [a, b] = [internals(s), internals(r)];
        assert.deepStrictEqual(b.state, a.state);
        assert.equal(b.nextSeq, a.nextSeq);
        assert.ok(b.nextId <= a.nextId && b.nextId > 0);
        // Ids minted but never stored need not survive a reopen; replay raises nextId past every stored id.
      },
    }))
      it(c.name, () => c.run());
  });

  const conv = (id = ROOT_CONVERSATION_ID) => [{ type: "conversation", value: { id } }] as const;
  const entry = (s: Storage, id: number) =>
    [
      { type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "message" } },
    ] as const;

  it("two writers on one log: the stale one loses on the seq key, is poisoned, reload sees the winner", async () => {
    const key = randomUUID();
    const a = await PostgresLogStorage.open(pool, key);
    await commitWrites(a, conv() as never, ctx);
    const b = await PostgresLogStorage.open(pool, key);
    const idA = await a.mintId();
    await commitWrites(a, entry(a, idA) as never, ctx);
    const idB = await b.mintId();
    await assert.rejects(commitWrites(b, entry(b, idB) as never, ctx), PostgresLogPoisonedError);
    await assert.rejects(b.conversation(ROOT_CONVERSATION_ID, ctx), PostgresLogPoisonedError);
    const r = await PostgresLogStorage.open(pool, key);
    // Both minted the same id (each from its own replay): exactly the race the seq key catches.
    assert.equal(idA, idB);
    assert.equal(
      (await r.scanEntries({ conversationId: ROOT_CONVERSATION_ID } as never, 10, undefined, ctx))
        .items.length,
      1,
    );
    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM prototype_durable_log WHERE log_key=$1",
      [key],
    );
    assert.equal(rows[0].n, 2);
  });

  it("lease fence: an epoch change refuses the append; nothing stored; reload is clean", async () => {
    const key = randomUUID();
    await pool.query("INSERT INTO spike_lease VALUES ($1, 1)", [key]);
    const held = 1;
    const fence = async (c: pg.PoolClient) => {
      const { rows } = await c.query("SELECT epoch FROM spike_lease WHERE key=$1 FOR SHARE", [key]);
      if (rows[0]?.epoch !== held) throw new Error("lease lost");
    };
    const s = await PostgresLogStorage.open(pool, key, { fence });
    await commitWrites(s, conv() as never, ctx);
    await pool.query("UPDATE spike_lease SET epoch = 2 WHERE key=$1", [key]);
    const id = await s.mintId();
    await assert.rejects(commitWrites(s, entry(s, id) as never, ctx), (e: Error) =>
      String((e.cause as Error)?.message).includes("lease lost"),
    );
    const r = await PostgresLogStorage.open(pool, key);
    assert.ok(await r.conversation(ROOT_CONVERSATION_ID, ctx));
    assert.equal(await r.entry(id as never, ctx), undefined);
    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM prototype_durable_log WHERE log_key=$1",
      [key],
    );
    assert.equal(rows[0].n, 1);
  });

  it("unknown outcome, not stored: failure before COMMIT -> poisoned; reload has no commit", async () => {
    const key = randomUUID();
    let fail = false;
    const s = await PostgresLogStorage.open(pool, key, {
      beforeCommit: async () => {
        if (fail) throw new Error("connection reset");
      },
    });
    await commitWrites(s, conv() as never, ctx);
    fail = true;
    const id = await s.mintId();
    await assert.rejects(commitWrites(s, entry(s, id) as never, ctx), PostgresLogPoisonedError);
    const r = await PostgresLogStorage.open(pool, key);
    assert.equal(await r.entry(id as never, ctx), undefined);
    // The reopened storage continues normally on the same seq.
    await commitWrites(r, entry(r, await r.mintId()) as never, ctx);
  });

  it("unknown outcome, stored: COMMIT landed but the reply was lost -> poisoned; reload HAS the commit", async () => {
    const key = randomUUID();
    let lose = false;
    const s = await PostgresLogStorage.open(pool, key, {
      beforeCommit: async (c) => {
        if (!lose) return;
        await c.query("COMMIT");
        throw new Error("reply lost");
      },
    });
    await commitWrites(s, conv() as never, ctx);
    lose = true;
    const id = await s.mintId();
    await assert.rejects(commitWrites(s, entry(s, id) as never, ctx), PostgresLogPoisonedError);
    const r = await PostgresLogStorage.open(pool, key);
    assert.ok(await r.entry(id as never, ctx));
  });

  it("refusal before any batch applied is a plain refusal, not poison", async () => {
    const s = await PostgresLogStorage.open(pool, randomUUID());
    await commitWrites(s, conv() as never, ctx);
    // An entry reusing the conversation's id: Durable's global-id check refuses it.
    const res = await s.commit([entry(s, ROOT_CONVERSATION_ID) as never], () => {}, ctx);
    assert.equal(res.stored, 0);
    assert.ok(res.refused);
    assert.ok(await s.conversation(ROOT_CONVERSATION_ID, ctx));
  });
});
