import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresStore, SqliteStore, append, initial, read, type Store } from "./store.ts";
import { ConversationDeleter } from "./deletion.ts";
import { FileEgressPolicyWriter, handsKey } from "./hands.ts";
import { api } from "./api.ts";
import type { Engine } from "./engine.ts";

const database = process.env.TEST_DATABASE_URL;
function fakes() {
  const jobs = new Set<string>();
  const nets = new Set<string>();
  const objects = new Map<string, string>();
  const calls: string[] = [];
  let failNetwork = 0;
  return {
    jobs,
    nets,
    objects,
    calls,
    failNetworkTimes: (n: number) => void (failNetwork = n),
    nomad: {
      purge: async (id: string) => void (calls.push(`purge ${id}`), jobs.delete(id)),
      jobIds: async (p: string) => [...jobs].filter((j) => j.startsWith(p)),
    },
    network: {
      release: async (k: string) => {
        calls.push(`release ${k}`);
        if (failNetwork-- > 0) throw new Error("network still in use");
        nets.delete(k);
      },
    },
    snapshots: {
      list: async (p: string) =>
        [...objects]
          .filter(([k]) => k.startsWith(p))
          .map(([key, lastModified]) => ({ key, lastModified })),
      delete: async (k: string) => void (calls.push(`s3 delete ${k}`), objects.delete(k)),
    },
  };
}
async function seed(
  store: Store,
  f: ReturnType<typeof fakes>,
  policies: string,
  owner: string,
  id: string,
) {
  await store.create(initial(id, owner));
  const key = handsKey(owner, id);
  await store.mutate(owner, id, (c) => {
    c.hands = {
      workspaceId: `ws-${key}`,
      generation: 2,
      state: "ready",
      jobId: `hands-${key}-g2`,
      allocId: "a",
      template: "t",
      image: "i",
      runtime: "kata",
      requestedEpoch: 0,
      updatedAt: new Date().toISOString(),
    };
    c.jobs.push({ id: "j", text: "x", status: "running" });
  });
  f.jobs.add(`hands-${key}-g2`);
  f.nets.add(key);
  f.objects.set(`sandboxes/ws-${key}/workspace.tar.gz`, new Date().toISOString());
  f.objects.set(
    `sandboxes/ws-${key}/workspace.after-failed-restore-g2.tar.gz`,
    new Date().toISOString(),
  );
  await writeFile(join(policies, `${key}.json`), "{}");
  return key;
}

for (const kind of ["sqlite", "postgres"] as const)
  test(
    `${kind}: delete removes every artifact, keeps others, idempotent`,
    { skip: kind === "postgres" && !database },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "del-"));
      const policies = join(dir, "policies");
      const store: Store =
        kind === "sqlite"
          ? new SqliteStore(join(dir, "s.sqlite"))
          : await PostgresStore.open(database!);
      t.after(async () => {
        await store.close();
        await rm(dir, { recursive: true, force: true });
      });
      const writer = new FileEgressPolicyWriter(policies);
      await writer.apply({
        version: 1,
        conversationKey: "0".repeat(20),
        workspaceId: "x",
        tainted: false,
        rules: [],
      });
      const f = fakes();
      const sfx = Math.random().toString(36).slice(2, 8);
      const [gone, kept] = [`del-${sfx}`, `keep-${sfx}`];
      const local: string[] = [];
      const d = new ConversationDeleter(
        store,
        {
          ...f,
          policies: writer,
          local: (o, i) => void local.push(i),
        },
        { networkRetryMs: 1 },
      );
      const k1 = await seed(store, f, policies, "o", gone);
      const k2 = await seed(store, f, policies, "o", kept);
      // Append-only still holds for ordinary deletes, even of a tombstoned conversation.
      f.failNetworkTimes(2); // bridge busy while the container stops: retried
      await d.tombstone("o", gone);
      await assert.rejects(read(store, "o", gone), /not found/);
      assert.equal(
        (await store.list("o")).items.some((c) => c.id === gone),
        false,
      );
      await assert.rejects(
        store.mutate("o", gone, (c) => void (c.title = "x")),
        /not found/,
      );
      const r = await d.finish("o", gone);
      assert.deepEqual(r.jobs.sort(), [`hands-${k1}-g1`, `hands-${k1}-g2`]);
      assert.equal(r.objects.length, 2);
      assert.ok(r.rows && r.network && r.policy);
      assert.deepEqual(local, [gone]);
      assert.ok(!f.jobs.has(`hands-${k1}-g2`) && !f.nets.has(k1));
      assert.ok(![...f.objects.keys()].some((k) => k.includes(k1)));
      assert.ok(!(await readdir(policies)).includes(`${k1}.json`));
      assert.deepEqual(
        (await store.refs()).filter((x) => x.id === gone),
        [],
      );
      // The other conversation is untouched.
      assert.ok(f.jobs.has(`hands-${k2}-g2`) && f.nets.has(k2));
      assert.equal([...f.objects.keys()].filter((k) => k.includes(k2)).length, 2);
      assert.ok((await readdir(policies)).includes(`${k2}.json`));
      assert.equal((await read(store, "o", kept)).id, kept);
      // Idempotent: a repeated delete is a 404 at tombstone, finish is a no-op.
      await assert.rejects(d.tombstone("o", gone), /not found/);
      assert.equal((await d.finish("o", gone)).rows, false);
      // Purge refuses a live conversation.
      await assert.rejects(store.purge("o", kept), /Only a deleted conversation/);
      // Orphan sweep: unrelated (grace-old) policy file and an orphan job/object go; known ones stay.
      f.jobs.add("hands-abcdefabcdefabcdefab-g1");
      f.objects.set("sandboxes/ws-abcdefabcdefabcdefab/workspace.tar.gz", "2020-01-01T00:00:00Z");
      await utimes(join(policies, `${"0".repeat(20)}.json`), new Date(0), new Date(0));
      const s = await d.sweep();
      assert.ok(!f.jobs.has("hands-abcdefabcdefabcdefab-g1"));
      assert.ok(!f.objects.has("sandboxes/ws-abcdefabcdefabcdefab/workspace.tar.gz"));
      assert.ok(!(await readdir(policies)).includes(`${"0".repeat(20)}.json`));
      assert.ok(f.jobs.has(`hands-${k2}-g2`) && (await readdir(policies)).includes(`${k2}.json`));
      assert.ok(s.orphans.length >= 3);
      if (kind === "postgres") {
        const { PostgresPreviewPorts } = await import("./preview.ts");
        const ports = await PostgresPreviewPorts.open(database!);
        await ports.share("o", kept, { port: 3000, label: "", cspSandbox: true });
        const { PostgresRenderStore } = await import("./visual.ts");
        const renders = await PostgresRenderStore.open(database!);
        const rid = `${randomBytes(16).toString("hex")}-html`;
        await renders.put(
          { id: rid, owner: "o", conversationId: kept, title: "t", height: 100, html: "<p>x</p>" },
          1e9,
        );
        const { default: pg } = await import("pg");
        const c = new pg.Client({ connectionString: database });
        await c.connect();
        // Outside the purge path the journal stays append-only, even for a tombstoned conversation.
        await d.tombstone("o", kept);
        await assert.rejects(
          c.query("DELETE FROM prototype_events WHERE conversation_id=$1", [kept]),
          /append-only/,
        );
        await d.finish("o", kept);
        const left = await c.query(
          "SELECT count(*)::int AS n FROM prototype_preview_ports WHERE conversation_id=$1",
          [kept],
        );
        assert.equal(left.rows[0].n, 0);
        assert.equal(await renders.get(rid), null, "visual reply pages go with the conversation");
        await renders.close();
        await c.end();
      }
    },
  );

test("a failed cleanup keeps the tombstone; the sweeper finishes it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "del-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const f = fakes();
  const d = new ConversationDeleter(
    store,
    { ...f, policies: new FileEgressPolicyWriter(join(dir, "p")) },
    { networkRetries: 0, networkRetryMs: 1 },
  );
  await (await import("node:fs/promises")).mkdir(join(dir, "p"), { recursive: true });
  await seed(store, f, join(dir, "p"), "o", "c");
  f.failNetworkTimes(1);
  await d.tombstone("o", "c");
  await assert.rejects(d.finish("o", "c"), /in use/);
  assert.equal((await store.refs())[0]?.deletedAt !== undefined, true);
  assert.equal((await d.sweep()).finished, 1);
  assert.deepEqual(await store.refs(), []);
});

test("journal rows stay append-only outside the purge path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "del-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await store.create(initial("c", "o"));
  await store.mutate("o", "c", (c) => void append(c, "x", {}));
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(join(dir, "s.sqlite"));
  raw.exec("PRAGMA busy_timeout=5000");
  assert.throws(() => raw.exec("DELETE FROM conversation_events"), /append-only/);
  raw.close();
});

test("DELETE /api/conversations/:id tombstones and cleans up; 404 afterwards", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "del-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  const d = new ConversationDeleter(store, {});
  const token = "t".repeat(40);
  const { server } = api({ store } as unknown as Engine, { [token]: "o" }, undefined, {
    deleter: d,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await store.create(initial("c", "o"));
  const port = (server.address() as { port: number }).port;
  const del = () =>
    fetch(`http://127.0.0.1:${port}/api/conversations/c`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  const r = await del();
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { deleted: boolean }).deleted, true);
  assert.deepEqual(await store.refs(), []);
  assert.equal((await del()).status, 404);
});

test("orphan dry run reports candidates without removing them", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "del-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const f = fakes();
  f.jobs.add("hands-abcdefabcdefabcdefab-g1");
  const d = new ConversationDeleter(store, f, { orphanDryRun: true });
  assert.deepEqual((await d.sweep()).orphans, [
    "job hands-abcdefabcdefabcdefab-g1",
    "network abcdefabcdefabcdefab",
  ]);
  assert.ok(f.jobs.has("hands-abcdefabcdefabcdefab-g1"));
});
