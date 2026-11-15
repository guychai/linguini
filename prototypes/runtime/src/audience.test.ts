// V1.3 audience check: a sensitive thread is never shareable beyond its owner; clean threads go
// to their project's members only; denies are journaled and answered 409 (owner) / 404 (others);
// membership changes and account deletion invalidate the member cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudienceCheck, NO_PROJECTS, type MemberSource } from "./audience.ts";
import { SqliteStore, initial, read } from "./store.ts";

async function setup(t: { after(f: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "audience-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const members = new Map<string, Set<string>>([["p1", new Set(["alice", "bob"])]]);
  let lookups = 0;
  const source: MemberSource = {
    members: async (p) => (lookups++, [...(members.get(p) ?? [])]),
  };
  let now = 1_000;
  const check = new AudienceCheck(store, source, { ttlMs: 10_000, now: () => now });
  const clean = { ...initial("clean", "alice"), projectId: "p1" };
  const sensitive = { ...initial("sens", "alice"), projectId: "p1", tainted: true };
  const loose = initial("loose", "alice");
  for (const c of [clean, sensitive, loose]) await store.create(c);
  return {
    store,
    check,
    members,
    lookups: () => lookups,
    tick: (ms: number) => void (now += ms),
  };
}

test("owner always; project members only for clean threads in that project", async (t) => {
  const { store, check } = await setup(t);
  const c = await read(store, "alice", "clean");
  assert.equal(await check.allowedAudience(c, { kind: "user", userId: "alice" }), true);
  assert.equal(await check.allowedAudience(c, { kind: "user", userId: "bob" }), true);
  assert.equal(await check.allowedAudience(c, { kind: "user", userId: "eve" }), false);
  assert.equal(await check.allowedAudience(c, { kind: "project", projectId: "p1" }), true);
  assert.equal(await check.allowedAudience(c, { kind: "project", projectId: "p2" }), false);
  // A thread outside any project is private.
  const loose = await read(store, "alice", "loose");
  assert.equal(await check.allowedAudience(loose, { kind: "user", userId: "bob" }), false);
  assert.equal(await check.allowedAudience(loose, { kind: "user", userId: "alice" }), true);
  // Before V1.4 nobody is a member of anything.
  const none = new AudienceCheck(store, NO_PROJECTS);
  assert.equal(await none.allowedAudience(c, { kind: "user", userId: "bob" }), false);
});

test("a sensitive thread is never shareable, even with its project's members", async (t) => {
  const { store, check } = await setup(t);
  const s = await read(store, "alice", "sens");
  for (const a of [
    { kind: "user", userId: "bob" },
    { kind: "project", projectId: "p1" },
  ] as const)
    assert.equal(await check.allowedAudience(s, a), false);
  assert.equal(await check.allowedAudience(s, { kind: "user", userId: "alice" }), true);
});

test("deny: share.denied journaled, 409 to the owner, 404 to anyone else, nothing else changes", async (t) => {
  const { store, check } = await setup(t);
  const before = await read(store, "alice", "sens");
  await assert.rejects(
    check.require("alice", "alice", "sens", { kind: "project", projectId: "p1" }, "invite"),
    (e: { status?: number; code?: string; message: string }) =>
      e.status === 409 && e.code === "share_denied" && !/sensitive/i.test(e.message),
  );
  await assert.rejects(
    check.require("bob", "alice", "sens", { kind: "user", userId: "bob" }, "open"),
    (e: { status?: number }) => e.status === 404,
  );
  const after = await read(store, "alice", "sens");
  const denied = after.events.filter((e) => e.type === "share.denied");
  assert.deepEqual(
    denied.map((e) => e.data),
    [
      { action: "invite", audience: "project", byOwner: true },
      { action: "open", audience: "user", byOwner: false },
    ],
  );
  assert.equal(after.tainted, before.tainted);
  assert.equal(after.projectId, before.projectId);
  assert.equal(after.events.length, before.events.length + 2);
  // Allowed: returns the thread and journals nothing.
  const ok = await check.require("bob", "alice", "clean", { kind: "user", userId: "bob" }, "open");
  assert.equal(ok.id, "clean");
  assert.equal(
    (await read(store, "alice", "clean")).events.some((e) => e.type === "share.denied"),
    false,
  );
});

test("member cache: TTL, membership change and account deletion invalidate", async (t) => {
  const { store, check, members, lookups, tick } = await setup(t);
  const c = await read(store, "alice", "clean");
  const bob = { kind: "user", userId: "bob" } as const;
  assert.equal(await check.allowedAudience(c, bob), true);
  assert.equal(await check.allowedAudience(c, bob), true);
  assert.equal(lookups(), 1);
  // Removed but cached: still allowed until invalidated (the removal path must invalidate).
  members.get("p1")!.delete("bob");
  check.invalidateProject("p1");
  assert.equal(await check.allowedAudience(c, bob), false);
  assert.equal(lookups(), 2);
  members.get("p1")!.add("carol");
  tick(10_001);
  assert.equal(await check.allowedAudience(c, { kind: "user", userId: "carol" }), true);
  assert.equal(lookups(), 3);
  members.get("p1")!.delete("carol");
  check.invalidateUser("carol");
  assert.equal(await check.allowedAudience(c, { kind: "user", userId: "carol" }), false);
});

test("a thread that turns sensitive stops being shareable immediately", async (t) => {
  const { store, check } = await setup(t);
  const bob = { kind: "user", userId: "bob" } as const;
  await check.require("bob", "alice", "clean", bob, "open");
  await store.mutate("alice", "clean", (c) => void (c.tainted = true));
  await assert.rejects(check.require("bob", "alice", "clean", bob, "open"), { status: 404 });
});
