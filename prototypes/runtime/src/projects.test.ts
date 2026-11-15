// V1.4a projects: roles, private threads (AM1.1, AM1.2), join-link rotation (AM1.5), removal
// detaching threads (AM1.6), 404 for non-members (AM1.9), viewers can't create threads, the
// sole-owner rule, account deletion, the PROJECTS / PROJECT_INVITES flags, and Postgres storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createAuth } from "./auth.ts";
import type { AddressInfo } from "node:net";
import { api } from "./api.ts";
import { AudienceCheck } from "./audience.ts";
import { Engine } from "./engine.ts";
import type { Harness } from "./harness.ts";
import {
  MemoryProjects,
  PostgresProjects,
  ProjectService,
  hashJoinToken,
  type ProjectStore,
} from "./projects.ts";
import { SqliteStore, initial, read } from "./store.ts";

const USERS = ["alice", "bob", "carol", "dave"];
const EMAILS: Record<string, string> = { "bob@x.example": "bob", "carol@x.example": "carol" };

async function rig(
  t: { after(f: () => unknown): void },
  opts: { invites?: boolean; repo?: ProjectStore } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "proj-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const audience = new AudienceCheck(store);
  let n = 0;
  const projects = new ProjectService(opts.repo ?? new MemoryProjects(), {
    store,
    audience,
    invites: opts.invites ?? true,
    newId: () => `p${++n}`,
    lookupUser: async (ref) =>
      ref.userId ? (USERS.includes(ref.userId) ? ref.userId : undefined) : EMAILS[ref.email!],
  });
  audience.useSource(projects.memberSource());
  return { store, projects, audience };
}

test("roles: owner creates, invites editor and viewer; viewer can't create threads", async (t) => {
  const { projects } = await rig(t);
  const p = await projects.create("alice", {
    name: " Apollo ",
    repos: [{ owner: "acme", name: "app" }],
  });
  assert.equal(p.name, "Apollo");
  assert.equal(p.role, "owner");
  await projects.invite("alice", p.id, { email: "Bob@x.example", role: "editor" });
  await projects.invite("alice", p.id, { userId: "carol" });
  assert.deepEqual(
    (await projects.members("bob", p.id)).map((m) => [m.userId, m.role]),
    [
      ["alice", "owner"],
      ["bob", "editor"],
      ["carol", "viewer"],
    ],
  );
  await assert.rejects(projects.invite("alice", p.id, { userId: "bob" }), { status: 409 });
  await assert.rejects(projects.invite("alice", p.id, { email: "nobody@x.example" }), {
    status: 404,
  });
  await assert.rejects(projects.invite("bob", p.id, { userId: "dave" }), { status: 403 });
  assert.equal(await projects.assertCanCreateThread("bob", p.id), p.id);
  await assert.rejects(projects.assertCanCreateThread("carol", p.id), { status: 403 });
  // AM1.9: non-members get 404 everywhere, same as a missing project.
  for (const call of [
    () => projects.get("dave", p.id),
    () => projects.members("dave", p.id),
    () => projects.threads("dave", p.id),
    () => projects.assertCanCreateThread("dave", p.id),
    () => projects.update("dave", p.id, { name: "x" }),
    () => projects.get("alice", "missing"),
  ])
    await assert.rejects(call(), { status: 404 });
  assert.deepEqual(
    (await projects.list("bob")).map((x) => x.id),
    [p.id],
  );
  assert.deepEqual(await projects.list("dave"), []);
});

test("AM1.2: the project board lists only the caller's own threads", async (t) => {
  const { projects, store } = await rig(t);
  const p = await projects.create("alice", { name: "P" });
  await projects.invite("alice", p.id, { userId: "bob", role: "editor" });
  await store.create({ ...initial("a1", "alice", "Alice plan"), projectId: p.id });
  await store.create({ ...initial("b1", "bob", "Bob secret plan"), projectId: p.id });
  await store.create(initial("b2", "bob", "Not in project"));
  assert.deepEqual(
    (await projects.threads("alice", p.id)).map((x) => x.title),
    ["Alice plan"],
  );
  assert.deepEqual(
    (await projects.threads("bob", p.id)).map((x) => x.title),
    ["Bob secret plan"],
  );
});

test("AM1.5: rotating the join link invalidates unused links; members stay", async (t) => {
  const { projects } = await rig(t);
  const p = await projects.create("alice", { name: "P" });
  const first = await projects.rotateJoinLink("alice", p.id, { role: "editor" });
  assert.equal((await projects.join("bob", first.token)).role, "editor");
  const second = await projects.rotateJoinLink("alice", p.id, {});
  await assert.rejects(projects.join("carol", first.token), { status: 404 });
  assert.equal((await projects.join("carol", second.token)).role, "viewer");
  assert.ok(await projects.repo.member(p.id, "bob"));
  await assert.rejects(projects.join("dave", "x".repeat(32)), { status: 404 });
  await assert.rejects(projects.rotateJoinLink("bob", p.id, {}), { status: 403 });
  // Only hashes are stored.
  assert.equal(await projects.repo.joinToken(second.token), undefined);
  assert.ok(await projects.repo.joinToken(hashJoinToken(second.token)));
  // Archived projects take no joins.
  await projects.update("alice", p.id, { archived: true });
  await assert.rejects(projects.join("dave", second.token), { status: 404 });
});

test("AM1.6: removal keeps the member's threads, owned by them, detached; sole owner can't leave", async (t) => {
  const { projects, store, audience } = await rig(t);
  const p = await projects.create("alice", { name: "P" });
  await projects.invite("alice", p.id, { userId: "bob", role: "editor" });
  await projects.invite("alice", p.id, { userId: "carol", role: "editor" });
  await store.create({ ...initial("b1", "bob", "Bob's"), projectId: p.id });
  await store.create({ ...initial("a1", "alice", "Alice's"), projectId: p.id });
  // Before removal bob is in the audience of alice's clean project thread.
  const a1 = await read(store, "alice", "a1");
  assert.equal(await audience.allowedAudience(a1, { kind: "user", userId: "bob" }), true);
  const r = await projects.remove("alice", p.id, "bob");
  assert.equal(r.detachedThreads, 1);
  const b1 = await read(store, "bob", "b1");
  assert.equal(b1.owner, "bob");
  assert.equal(b1.projectId, undefined);
  assert.ok(b1.events.some((e) => e.type === "project.detached"));
  // The member cache was invalidated by the removal.
  assert.equal(await audience.allowedAudience(a1, { kind: "user", userId: "bob" }), false);
  await assert.rejects(projects.get("bob", p.id), { status: 404 });
  // Members may leave; non-owners can't remove others; the only owner can't leave.
  await assert.rejects(projects.remove("carol", p.id, "alice"), { status: 403 });
  await projects.remove("carol", p.id, "carol");
  await assert.rejects(projects.remove("alice", p.id, "alice"), { status: 409 });
});

test("account deletion drops memberships; an ownerless project is archived", async (t) => {
  const { projects } = await rig(t);
  const p = await projects.create("alice", { name: "P" });
  await projects.invite("alice", p.id, { userId: "bob", role: "editor" });
  await projects.rotateJoinLink("alice", p.id, {});
  assert.deepEqual(await projects.removeUser("alice"), [p.id]);
  const after = await projects.get("bob", p.id);
  assert.ok(after.archivedAt);
  assert.deepEqual(
    (await projects.members("bob", p.id)).map((m) => m.userId),
    ["bob"],
  );
  assert.deepEqual(await projects.list("bob"), []);
});

test("invites off (PROJECT_INVITES unset): invites and links are 501", async (t) => {
  const { projects } = await rig(t, { invites: false });
  const p = await projects.create("alice", { name: "P" });
  for (const call of [
    () => projects.invite("alice", p.id, { userId: "bob" }),
    () => projects.rotateJoinLink("alice", p.id, {}),
    () => projects.join("bob", "x".repeat(32)),
  ])
    await assert.rejects(call(), { status: 501 });
});

async function http(t: { after(f: () => unknown): void }, withProjects: boolean) {
  const { store, projects } = await rig(t);
  const engine = new Engine(
    store,
    async (): Promise<Harness> => ({
      async run() {},
      async steer() {},
      async abort() {},
      dispose() {},
    }),
    { heartbeatMs: 0, worker: "W" },
  );
  const tokens = Object.fromEntries(USERS.map((u) => [`${u}-`.padEnd(40, "t"), u]));
  const { server, closeStreams } = api(engine, tokens, undefined, withProjects ? { projects } : {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    closeStreams();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${`${who}-`.padEnd(40, "t")}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  return { call, store };
}

test("HTTP: routes, AM1.1 (editor 404 on another member's thread), projectId on create", async (t) => {
  const { call } = await http(t, true);
  const p = await call("alice", "POST", "/api/projects", { name: "P" });
  assert.equal(p.status, 201);
  const id = p.body.id;
  assert.equal(
    (await call("alice", "POST", `/api/projects/${id}/members`, { userId: "bob", role: "editor" }))
      .status,
    201,
  );
  assert.equal(
    (await call("alice", "POST", `/api/projects/${id}/members`, { userId: "carol" })).status,
    201,
  );
  assert.equal(
    (await call("alice", "POST", "/api/conversations", { id: "a1", title: "A", projectId: id }))
      .body.projectId,
    id,
  );
  assert.equal(
    (await call("bob", "POST", "/api/conversations", { id: "b1", projectId: id })).status,
    201,
  );
  assert.equal(
    (await call("carol", "POST", "/api/conversations", { id: "c1", projectId: id })).status,
    403,
  );
  assert.equal(
    (await call("dave", "POST", "/api/conversations", { id: "d1", projectId: id })).status,
    404,
  );
  // AM1.1: a project editor still gets 404 on another member's thread (and its sub-routes).
  assert.equal((await call("bob", "GET", "/api/conversations/a1")).status, 404);
  assert.equal((await call("bob", "GET", "/api/conversations/a1/events")).status, 404);
  assert.deepEqual(
    (await call("bob", "GET", `/api/projects/${id}/threads`)).body.threads.map(
      (x: { id: string }) => x.id,
    ),
    ["b1"],
  );
  assert.equal((await call("dave", "GET", `/api/projects/${id}`)).status, 404);
  assert.equal((await call("dave", "GET", `/api/projects/${id}/members`)).status, 404);
  const link = await call("alice", "POST", `/api/projects/${id}/join-link`);
  assert.equal(link.status, 200);
  assert.equal(
    (await call("dave", "POST", `/api/projects/join/${link.body.token}`)).body.role,
    "viewer",
  );
  assert.equal((await call("bob", "DELETE", `/api/projects/${id}/members/bob`)).status, 200);
  assert.equal((await call("alice", "DELETE", `/api/projects/${id}/members/alice`)).status, 409);
  assert.deepEqual((await call("bob", "GET", "/api/projects")).body.projects, []);
});

test("HTTP: PROJECTS off: /api/projects is 404 and projectId is refused", async (t) => {
  const { call } = await http(t, false);
  assert.equal((await call("alice", "GET", "/api/projects")).status, 404);
  assert.equal(
    (await call("alice", "POST", "/api/conversations", { id: "a1", projectId: "p1" })).status,
    400,
  );
  assert.equal(
    (await call("alice", "POST", "/api/conversations", { id: "a2" })).body.projectId,
    null,
  );
});

const database = process.env.TEST_DATABASE_URL;
test(
  "PostgresProjects: same rules on Postgres; memberships cascade with the user row",
  { skip: !database },
  async (t) => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: database!, max: 2 });
    t.after(() => pool.end());
    const sfx = randomUUID().slice(0, 8);
    // Better Auth's own migrations create the "user" table the memberships reference.
    await createAuth({
      secret: randomBytes(32).toString("hex"),
      baseURL: "http://localhost",
      pool,
    });
    const ids = Object.fromEntries(USERS.map((u) => [u, `${u}-${sfx}`]));
    const cols = (
      await pool.query(
        `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_name='user'`,
      )
    ).rows;
    // Better Auth's user table (if present) has more NOT NULL columns; fill what it needs.
    for (const id of Object.values(ids)) {
      const need = cols.filter(
        (c) => c.column_name !== "id" && c.is_nullable === "NO" && c.column_default === null,
      );
      const values = need.map((c) =>
        /at$/i.test(c.column_name)
          ? new Date()
          : /verified|banned/i.test(c.column_name)
            ? false
            : `${id}@${c.column_name}.example`,
      );
      await pool.query(
        `INSERT INTO "user" (id${need.map((c) => `, "${c.column_name}"`).join("")}) VALUES ($1${need.map((_, i) => `, $${i + 2}`).join("")})`,
        [id, ...values],
      );
    }
    const repo = await PostgresProjects.open(pool);
    const pid = `p-${sfx}`;
    const service = new ProjectService(repo, {
      store: (await rig(t)).store,
      invites: true,
      newId: () => pid,
      lookupUser: async (ref) => ref.userId,
    });
    await service.create(ids.alice!, { name: "PG" });
    await service.invite(ids.alice!, pid, { userId: ids.bob!, role: "editor" });
    const link = await service.rotateJoinLink(ids.alice!, pid, {});
    await service.join(ids.carol!, link.token);
    const again = await service.rotateJoinLink(ids.alice!, pid, { role: "editor" });
    await assert.rejects(service.join(ids.dave!, link.token), { status: 404 });
    assert.equal((await service.join(ids.dave!, again.token)).role, "editor");
    assert.deepEqual(
      (await service.members(ids.bob!, pid)).map((m) => m.role),
      ["owner", "editor", "viewer", "editor"],
    );
    await service.update(ids.alice!, pid, { name: "Renamed", repos: [{ owner: "a", name: "b" }] });
    const got = await service.get(ids.bob!, pid);
    assert.equal(got.name, "Renamed");
    assert.deepEqual(got.repos, [{ provider: "github", owner: "a", name: "b" }]);
    await assert.rejects(service.remove(ids.alice!, pid, ids.alice!), { status: 409 });
    // Deleting the user row cascades their memberships.
    await pool.query(`DELETE FROM "user" WHERE id=$1`, [ids.dave]);
    assert.equal(await repo.member(pid, ids.dave!), undefined);
    assert.deepEqual(await service.removeUser(ids.alice!), [pid]);
    assert.ok((await service.get(ids.bob!, pid)).archivedAt);
    await pool.query(`DELETE FROM prototype_projects WHERE id=$1`, [pid]);
    await pool.query(`DELETE FROM "user" WHERE id = ANY($1)`, [Object.values(ids)]);
  },
);
