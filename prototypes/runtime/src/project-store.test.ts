// V1.5 project store: copy-on-grant; the sensitive flag lands before any byte is visible (AM1.3);
// sensitive threads can't write back (AM1.4); removal stops future grants; roles; archived
// projects; the sandbox copy script; Postgres storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { AudienceCheck } from "./audience.ts";
import { createAuth } from "./auth.ts";
import {
  GRANT_SCRIPT,
  MemoryArtifacts,
  PostgresArtifacts,
  ProjectArtifacts,
  type ThreadFiles,
} from "./project-store.ts";
import { MemoryProjects, PostgresProjects, ProjectService } from "./projects.ts";
import { SqliteStore, initial, read } from "./store.ts";

async function rig(t: { after(f: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "pstore-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const audience = new AudienceCheck(store);
  const projects = new ProjectService(new MemoryProjects(), {
    store,
    audience,
    invites: true,
    newId: () => "p1",
    lookupUser: async (r) => r.userId,
  });
  audience.useSource(projects.memberSource());
  const sandbox = new Map<string, string>();
  const writes: Array<{ thread: string; name: string; taintedAtWrite: boolean }> = [];
  const files: ThreadFiles = {
    read: async (owner, id, path) => sandbox.get(`${owner}/${id}/${path}`) ?? "",
    put: async (owner, id, name, content) => {
      writes.push({ thread: id, name, taintedAtWrite: (await read(store, owner, id)).tainted });
      sandbox.set(`${owner}/${id}/.project/${name}`, content);
    },
  };
  const artifacts = new ProjectArtifacts({
    store,
    projects,
    artifacts: new MemoryArtifacts(),
    files,
  });
  await projects.create("alice", { name: "P" });
  await projects.invite("alice", "p1", { userId: "bob", role: "editor" });
  await projects.invite("alice", "p1", { userId: "carol", role: "viewer" });
  await store.create({ ...initial("a1", "alice"), projectId: "p1" });
  await store.create({ ...initial("b1", "bob"), projectId: "p1" });
  await store.create(initial("b-loose", "bob"));
  return { store, projects, artifacts, sandbox, writes };
}

test("AM1.3: a sensitive artifact sets the thread's flag before the file is written", async (t) => {
  const { store, artifacts, sandbox, writes } = await rig(t);
  const clean = await artifacts.write("alice", "p1", { name: "readme.md", content: "hello" });
  const secret = await artifacts.write("alice", "p1", {
    name: "q3.csv",
    content: "customer,revenue",
    sensitive: true,
  });
  assert.equal(clean.sensitive, false);
  assert.equal(secret.sensitive, true);
  assert.deepEqual(await artifacts.grant("bob", "b1", { artifactId: clean.id }), {
    path: ".project/readme.md",
    sensitive: false,
  });
  assert.equal((await read(store, "bob", "b1")).tainted, false);
  await artifacts.grant("bob", "b1", { artifactId: secret.id });
  assert.deepEqual(writes, [
    { thread: "b1", name: "readme.md", taintedAtWrite: false },
    { thread: "b1", name: "q3.csv", taintedAtWrite: true },
  ]);
  assert.equal(sandbox.get("bob/b1/.project/q3.csv"), "customer,revenue");
  const b1 = await read(store, "bob", "b1");
  assert.equal(b1.tainted, true);
  const types = b1.events.map((e) => e.type);
  assert.ok(types.indexOf("taint.changed") < types.lastIndexOf("store.granted"));
  assert.deepEqual(
    b1.events.filter((e) => e.type === "store.granted").map((e) => e.data.sensitive),
    [false, true],
  );
});

test("AM1.4: a sensitive thread can read from the store but never write back", async (t) => {
  const { store, artifacts, sandbox } = await rig(t);
  sandbox.set("bob/b1/notes.md", "from b1");
  const ok = await artifacts.write("bob", "p1", { conversationId: "b1", path: "notes.md" });
  assert.equal(ok.name, "notes.md");
  assert.equal(ok.sensitive, false);
  await store.mutate("bob", "b1", (c) => void (c.tainted = true));
  await assert.rejects(
    artifacts.write("bob", "p1", { conversationId: "b1", path: "notes.md", name: "again.md" }),
    (e: { status?: number; code?: string }) =>
      e.status === 409 && e.code === "store_sensitive_source",
  );
  const b1 = await read(store, "bob", "b1");
  assert.ok(b1.events.some((e) => e.type === "store.denied"));
  assert.deepEqual(
    (await artifacts.list("bob", "p1")).map((a) => a.name),
    ["notes.md"],
  );
  // Reading (a grant) still works into the sensitive thread.
  await artifacts.grant("bob", "b1", { artifactId: ok.id });
});

test("a thread that turns sensitive during the copy is refused", async (t) => {
  const { store, artifacts } = await rig(t);
  const racing = new ProjectArtifacts({
    store,
    projects: (artifacts as unknown as { o: { projects: ProjectService } }).o.projects,
    artifacts: new MemoryArtifacts(),
    files: {
      read: async (owner, id) => {
        await store.mutate(owner, id, (c) => void (c.tainted = true));
        return "secret";
      },
      put: async () => {},
    },
  });
  await assert.rejects(
    racing.write("bob", "p1", { conversationId: "b1", path: "x.md" }),
    (e: { code?: string }) => e.code === "store_sensitive_source",
  );
});

test("roles, membership, project boundary, archived projects, removal stops grants", async (t) => {
  const { projects, artifacts, sandbox } = await rig(t);
  const a = await artifacts.write("alice", "p1", { name: "doc.md", content: "x" });
  // Viewers read the list but can't write; non-members get 404.
  assert.equal((await artifacts.list("carol", "p1")).length, 1);
  await assert.rejects(artifacts.write("carol", "p1", { name: "n.md", content: "" }), {
    status: 403,
  });
  await assert.rejects(artifacts.list("dave", "p1"), { status: 404 });
  // Only one's own threads, and only threads in the project.
  await assert.rejects(artifacts.grant("bob", "a1", { artifactId: a.id }), { status: 404 });
  await assert.rejects(artifacts.grant("bob", "b-loose", { artifactId: a.id }), { status: 409 });
  await assert.rejects(artifacts.grant("bob", "b1", { artifactId: "a_missing" }), { status: 404 });
  // Bad names never reach the sandbox.
  for (const name of [".hidden", "../x", "a/b", ""])
    await assert.rejects(artifacts.write("alice", "p1", { name, content: "" }), { status: 400 });
  // Delete: owner or author only.
  const bobs = await artifacts.write("bob", "p1", { name: "bob.md", content: "b" });
  await assert.rejects(artifacts.remove("carol", "p1", bobs.id), { status: 403 });
  await artifacts.remove("bob", "p1", bobs.id);
  // Removal: the copy already granted stays; further grants are 404 (bob is no member).
  await artifacts.grant("bob", "b1", { artifactId: a.id });
  await projects.remove("alice", "p1", "bob");
  assert.equal(sandbox.get("bob/b1/.project/doc.md"), "x");
  await assert.rejects(artifacts.grant("bob", "b1", { artifactId: a.id }), { status: 409 });
  await assert.rejects(artifacts.list("bob", "p1"), { status: 404 });
  // Archived: no writes, no grants.
  await projects.update("alice", "p1", { archived: true });
  await assert.rejects(artifacts.write("alice", "p1", { name: "late.md", content: "" }), {
    status: 409,
  });
  await assert.rejects(artifacts.grant("alice", "a1", { artifactId: a.id }), { status: 409 });
});

test("grant script: atomic copy into .project, refuses a symlinked .project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "grant-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (name: string, input: string, dir = root) =>
    execFileSync("bash", ["-c", GRANT_SCRIPT, "linguini-grant", name, dir], {
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  run("a.md", "one");
  run("a.md", "two");
  assert.equal(await readFile(join(root, ".project", "a.md"), "utf8"), "two");
  assert.throws(() => run("../x", "no"));
  assert.throws(() => run(".x", "no"));
  const other = await mkdtemp(join(tmpdir(), "grant2-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const evil = join(other, "ws");
  await mkdir(evil);
  await symlink("/tmp", join(evil, ".project"));
  assert.throws(() => run("a.md", "no", evil));
});

const database = process.env.TEST_DATABASE_URL;
test("PostgresArtifacts: put/replace/list/get/remove", { skip: !database }, async (t) => {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: database!, max: 2 });
  t.after(() => pool.end());
  await createAuth({ secret: randomBytes(32).toString("hex"), baseURL: "http://localhost", pool });
  const repo = await PostgresProjects.open(pool);
  const store = await PostgresArtifacts.open(pool);
  const pid = `p-${randomUUID().slice(0, 8)}`;
  await pool.query("INSERT INTO prototype_projects (id, name, created_by) VALUES ($1,'P','x')", [
    pid,
  ]);
  void repo;
  const base = { projectId: pid, createdBy: "x", createdAt: new Date().toISOString() };
  await store.put({ ...base, id: "a1", name: "n.md", sensitive: false, content: "héllo" });
  await store.put({ ...base, id: "a2", name: "n.md", sensitive: true, content: "v2" });
  const list = await store.list(pid);
  assert.deepEqual(
    list.map((a) => [a.id, a.name, a.sensitive, a.bytes]),
    [["a2", "n.md", true, 2]],
  );
  assert.equal((await store.get(pid, "a2"))!.content, "v2");
  assert.equal(await store.get("other", "a2"), undefined);
  await store.remove(pid, "a2");
  assert.deepEqual(await store.list(pid), []);
  await pool.query("DELETE FROM prototype_projects WHERE id=$1", [pid]);
});
