// Paged listing and paged history: list() returns bounded pages (journals only on request,
// one query per page) and the SSE catch-up reads the journal in bounded batches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_PAGE_DEFAULT,
  LIST_PAGE_DEFAULT,
  PostgresStore,
  SqliteStore,
  append,
  initial,
  listAll,
  type ListOptions,
  type Store,
} from "./store.ts";
import { Engine } from "./engine.ts";
import { api } from "./api.ts";

const database = process.env.TEST_DATABASE_URL;
async function open(kind: "sqlite" | "postgres") {
  const dir = await mkdtemp(join(tmpdir(), "owned-paging-"));
  const store: Store =
    kind === "sqlite"
      ? new SqliteStore(join(dir, "state.sqlite"))
      : await PostgresStore.open(database!, { listen: false });
  return {
    store,
    close: async () => {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function seed(store: Store, owner: string, count: number, eventsEach: (i: number) => number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `c${String(i).padStart(3, "0")}-${randomUUID().slice(0, 8)}`;
    ids.push(id);
    await store.create(initial(id, owner, `t${i}`));
    const n = eventsEach(i);
    if (n)
      await store.mutate(owner, id, (c) => {
        for (let k = 0; k < n; k++) append(c, "test.event", { i, k });
      });
  }
  return ids.sort();
}

for (const kind of ["sqlite", "postgres"] as const) {
  test(
    `${kind}: list() pages by id, loads journals only on request, and isolates owners`,
    {
      skip: kind === "postgres" && !database,
      timeout: 30_000,
    },
    async () => {
      const { store, close } = await open(kind);
      try {
        const owner = `pg-${randomUUID()}`,
          other = `pg-${randomUUID()}`;
        const ids = await seed(store, owner, 7, (i) => i);
        await seed(store, other, 2, () => 1);

        const seen: string[] = [];
        const pages: number[] = [];
        let after: string | undefined;
        for (;;) {
          const options: ListOptions = { limit: 3, ...(after ? { after } : {}) };
          const page = await store.list(owner, options);
          pages.push(page.items.length);
          for (const c of page.items) {
            assert.equal(c.owner, owner);
            assert.deepEqual(c.events, [], "journals are not loaded unless asked");
            seen.push(c.id);
          }
          if (page.next === null) break;
          assert.equal(page.next, page.items.at(-1)!.id);
          after = page.next;
        }
        assert.deepEqual(pages, [3, 3, 1]);
        assert.deepEqual(seen, ids);

        // With events: each journal matches the full snapshot, cut at the committed lastSeq.
        const withEvents = await store.list(owner, { limit: 4, events: true });
        assert.equal(withEvents.items.length, 4);
        assert.ok(withEvents.next);
        for (const c of withEvents.items) {
          const full = await store.snapshot(owner, c.id);
          assert.deepEqual(c.events, full.events);
          assert.equal(c.events.length, c.lastSeq);
        }
        assert.ok(withEvents.items.some((c) => c.events.length > 0));

        // An exact-size final page reports no further cursor; an empty tail returns nothing.
        const exact = await store.list(owner, { limit: 7 });
        assert.equal(exact.items.length, 7);
        assert.equal(exact.next, null);
        assert.deepEqual(await store.list(owner, { after: ids.at(-1)! }), {
          items: [],
          next: null,
        });
        // Out-of-range limits are clamped rather than unbounded.
        assert.equal((await store.list(owner, { limit: 0 })).items.length, 1);

        const all: string[] = [];
        for await (const c of listAll(store, owner, { limit: 2 })) all.push(c.id);
        assert.deepEqual(all, ids);
      } finally {
        await close();
      }
    },
  );

  test(
    `${kind}: events() returns bounded batches that concatenate to the full journal`,
    {
      skip: kind === "postgres" && !database,
      timeout: 30_000,
    },
    async () => {
      const { store, close } = await open(kind);
      try {
        const owner = `pg-${randomUUID()}`;
        const [id] = await seed(store, owner, 1, () => 25);
        const full = (await store.snapshot(owner, id!)).events;
        const batches: number[] = [];
        const joined = [];
        let cursor = 0;
        for (;;) {
          const batch = await store.events(owner, id!, cursor, 10);
          if (!batch.length) break;
          batches.push(batch.length);
          joined.push(...batch);
          cursor = batch.at(-1)!.seq;
        }
        assert.deepEqual(batches, [10, 10, 5]);
        assert.deepEqual(joined, full);
        assert.ok((await store.events(owner, id!, 0)).length <= EVENT_PAGE_DEFAULT);
      } finally {
        await close();
      }
    },
  );
}

test(
  "engine recover and sweep walk every page without loading journals",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "owned-paging-engine-"));
    const store = new SqliteStore(join(dir, "state.sqlite"));
    const engine = new Engine(store, async () => {
      throw new Error("not scheduled in this test");
    });
    try {
      const owner = "paging-owner";
      const count = LIST_PAGE_DEFAULT * 2 + 5;
      const ids = await seed(store, owner, count, () => 0);
      const pending = ids[LIST_PAGE_DEFAULT + 3]!; // lives on the second page
      await store.mutate(owner, pending, (c) => {
        c.jobs.push({ id: "j1", status: "queued" } as (typeof c.jobs)[number]);
        c.lease = null;
      });
      const calls: ListOptions[] = [];
      const list = store.list.bind(store);
      store.list = async (o, options = {}) => {
        calls.push(options);
        return list(o, options);
      };
      const scheduled: string[] = [];
      (engine as unknown as { schedule: (o: string, id: string) => void }).schedule = (_o, id) =>
        scheduled.push(id);

      await engine.recover(owner);
      assert.deepEqual(scheduled.sort(), ids);
      assert.equal(calls.length, 3, "three pages of at most LIST_PAGE_DEFAULT");
      assert.ok(calls.every((o) => !o.events));

      scheduled.length = 0;
      calls.length = 0;
      await engine.sweep(owner);
      assert.deepEqual(scheduled, [pending]);
      assert.equal(calls.length, 3);
    } finally {
      await engine.stop();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "HTTP: conversation list pages via X-Next-Cursor and SSE catch-up spans event pages",
  {
    timeout: 30_000,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "owned-paging-http-"));
    const store = new SqliteStore(join(dir, "state.sqlite"));
    const engine = new Engine(store, async () => {
      throw new Error("no runs in this test");
    });
    const token = "test-only-paging-token-000000000000000";
    const { server, closeStreams } = api(engine, { [token]: "alice" });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const get = (path: string, signal?: AbortSignal) =>
      fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` }, signal });
    try {
      const ids = await seed(store, "alice", 5, (i) => i);
      await seed(store, "bob", 3, () => 0);

      const first = await get("/api/conversations?limit=2");
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as Array<{ id: string; events: unknown[] }>;
      assert.deepEqual(
        firstBody.map((c) => c.id),
        ids.slice(0, 2),
      );
      assert.equal(first.headers.get("x-next-cursor"), ids[1]);
      assert.ok(
        firstBody[1]!.events.length > 0,
        "the API page still carries journals for the shell",
      );
      const last = await get(`/api/conversations?limit=2&cursor=${ids[3]}`);
      assert.deepEqual(
        ((await last.json()) as Array<{ id: string }>).map((c) => c.id),
        [ids[4]],
      );
      assert.equal(last.headers.get("x-next-cursor"), null);
      const unpaged = await get("/api/conversations");
      assert.equal(((await unpaged.json()) as unknown[]).length, 5);
      for (const bad of ["limit=0", "limit=abc", "limit=99999", "cursor=..%2F"])
        assert.equal((await get(`/api/conversations?${bad}`)).status, 400, bad);

      // A history longer than one event page streams completely and in order.
      const total = EVENT_PAGE_DEFAULT * 2 + 37;
      const long = `long-${randomUUID().slice(0, 8)}`;
      await store.create(initial(long, "alice"));
      await store.mutate("alice", long, (c) => {
        for (let k = 1; k <= total; k++) append(c, "test.event", { k });
      });
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 10_000); // fail fast if catch-up stalls
      const stream = await get(`/api/conversations/${long}/events?after=0`, controller.signal);
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader(),
        decoder = new TextDecoder();
      let text = "";
      const seqs: number[] = [];
      while (seqs.at(-1) !== total) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        let end;
        while ((end = text.indexOf("\n\n")) >= 0) {
          const frame = text.slice(0, end);
          text = text.slice(end + 2);
          const id = frame.match(/^id: (\d+)$/m);
          if (id) seqs.push(Number(id[1]));
        }
      }
      clearTimeout(deadline);
      controller.abort();
      assert.deepEqual(
        seqs,
        Array.from({ length: total }, (_, i) => i + 1),
      );
    } finally {
      closeStreams();
      server.close();
      await engine.stop();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
