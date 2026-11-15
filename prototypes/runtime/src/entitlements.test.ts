// V1.6a entitlements: precedence (AM1.7), default deny for gated objects, project rules only
// narrow, bootstrap env lists, broker enforcement (execute and preflight) with Trino still running
// as the thread owner, the HTTP routes, and Postgres storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { api } from "./api.ts";
import { createAuth } from "./auth.ts";
import { Engine } from "./engine.ts";
import {
  Entitlements,
  MemoryRules,
  PostgresRules,
  evaluate,
  parseRule,
  type Rule,
} from "./entitlements.ts";
import { githubCreatePrTool, GitHubPublisher, publishConfigFromEnv } from "./github_pr.ts";
import type { Harness } from "./harness.ts";
import { HostToolRegistry } from "./host-tools.ts";
import { MemoryProjects, ProjectService } from "./projects.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import { SqliteStore, initial } from "./store.ts";
import { FakeTrino, trinoHostTool } from "./trino.ts";

const trino = { type: "tool", name: "trino_query" } as const;
const pr = { type: "tool", name: "github_create_pr" } as const;
const r = (subject: Rule["subject"], object: Rule["object"], effect: Rule["effect"]): Rule => ({
  subject,
  object,
  effect,
});

test("AM1.7: org deny wins over every allow, with or without a project", () => {
  const rules = [
    r({ type: "org" }, trino, "deny"),
    r({ type: "project", id: "p1" }, trino, "allow"),
    r({ type: "user", id: "alice" }, trino, "allow"),
  ];
  assert.equal(evaluate(rules, { userId: "alice", projectId: "p1" }, trino).allowed, false);
  assert.equal(evaluate(rules, { userId: "alice" }, trino).reason, "org-deny");
});

test("precedence: project deny > user/role deny > user allow > role allow > org allow", () => {
  const rules = [
    r({ type: "org" }, pr, "allow"),
    r({ type: "project", id: "p1" }, pr, "deny"),
    r({ type: "user", id: "bob" }, pr, "deny"),
    r({ type: "role", id: "contractor" }, pr, "deny"),
  ];
  assert.equal(evaluate(rules, { userId: "alice" }, pr).reason, "org-allow");
  assert.equal(evaluate(rules, { userId: "alice", projectId: "p1" }, pr).reason, "project-deny");
  assert.equal(evaluate(rules, { userId: "bob" }, pr).reason, "user-deny");
  assert.equal(evaluate(rules, { userId: "carol", role: "contractor" }, pr).reason, "user-deny");
  assert.equal(
    evaluate([r({ type: "role", id: "admin" }, pr, "allow")], { userId: "x", role: "admin" }, pr)
      .reason,
    "role-allow",
  );
});

test("gated objects are denied without an allow; built-in tools are allowed unless denied", () => {
  for (const o of [
    trino,
    pr,
    { type: "mcp", name: "linear" },
    { type: "scope", name: "github_read" },
  ] as const)
    assert.deepEqual(evaluate([], { userId: "a" }, o), {
      allowed: false,
      reason: "no-entitlement",
    });
  const bash = { type: "tool", name: "bash" } as const;
  assert.equal(evaluate([], { userId: "a" }, bash).allowed, true);
  assert.equal(evaluate([r({ type: "org" }, bash, "deny")], { userId: "a" }, bash).allowed, false);
  // mcp "*" covers every server.
  const any = r({ type: "org" }, { type: "mcp", name: "*" }, "allow");
  assert.equal(evaluate([any], { userId: "a" }, { type: "mcp", name: "linear" }).allowed, true);
});

test("parseRule: project rules can only deny; subjects validated", () => {
  assert.throws(
    () => parseRule({ object: trino, effect: "allow" }, { projectId: "p1" }),
    /only deny/,
  );
  assert.deepEqual(parseRule({ object: trino, effect: "deny" }, { projectId: "p1" }), {
    subject: { type: "project", id: "p1" },
    object: trino,
    effect: "deny",
  });
  assert.throws(() =>
    parseRule({ subject: { type: "project", id: "p1" }, object: trino, effect: "allow" }, "admin"),
  );
  assert.throws(() =>
    parseRule(
      { subject: { type: "org" }, object: { type: "tool", name: "*" }, effect: "allow" },
      "admin",
    ),
  );
  assert.throws(() =>
    parseRule({ subject: { type: "org" }, object: trino, effect: "maybe" }, "admin"),
  );
});

test("bootstrap: GITHUB_APP_OWNERS / GITHUB_PUBLISH_OWNERS still allow, unless denied", async () => {
  const e = await new Entitlements(new MemoryRules(), {
    githubRead: ["alice"],
    publish: ["alice"],
  }).load();
  assert.equal(e.decide("alice", { type: "scope", name: "github_read" }).reason, "bootstrap-env");
  assert.equal(e.allowed("alice", pr), true);
  assert.equal(e.allowed("bob", pr), false);
  await e.replace("admin", [{ subject: { type: "org" }, object: pr, effect: "deny" }], "admin");
  assert.equal(e.allowed("alice", pr), false);
  // Roles come from the loader; deleting a user drops their rules.
  const roles = await new Entitlements(new MemoryRules(), {}, async () => [
    ["root", "admin"],
  ]).load();
  await roles.replace(
    "admin",
    [{ subject: { type: "role", id: "admin" }, object: trino, effect: "allow" }],
    "root",
  );
  assert.equal(roles.allowed("root", trino), true);
  await roles.replace(
    "admin",
    [{ subject: { type: "user", id: "u1" }, object: trino, effect: "allow" }],
    "root",
  );
  assert.equal(roles.allowed("u1", trino), true);
  await roles.removeUser("u1");
  assert.equal(roles.allowed("u1", trino), false);
});

async function brokerRig(t: { after(f: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "ent-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ent = await new Entitlements(new MemoryRules()).load();
  const fake = new FakeTrino(new Set(["alice", "bob"]));
  const broker = new SandboxBroker(store, new FixtureSandbox(), {
    hostTools: new HostToolRegistry({
      trino_query: trinoHostTool({ client: fake, emailOf: async (o) => `${o}@corp.example` }),
    }),
    entitled: (c, tool) => ent.assertTool(c.owner, tool, c.projectId),
  });
  for (const o of ["alice", "bob"]) await store.create(initial(`c-${o}`, o));
  await store.create({ ...initial("c-alice-p", "alice"), projectId: "p1" });
  return { store, broker, ent, fake };
}

test("broker: trino_query refused without an entitlement (execute and preflight); runs as the owner when allowed", async (t) => {
  const { broker, ent, fake } = await brokerRig(t);
  const call = (owner: string, id = `c-${owner}`) =>
    broker.execute(owner, id, {
      id: `q-${Math.random()}`,
      tool: "trino_query",
      args: { sql: "show tables" },
    });
  await assert.rejects(
    call("alice"),
    (e: { code?: string; message: string }) =>
      e.code === "entitlement_denied" && /not enabled for your account/.test(e.message),
  );
  await assert.rejects(broker.preflight("alice", "c-alice", "trino_query", {}), {
    code: "entitlement_denied",
  });
  assert.deepEqual(fake.queries, []);
  await ent.replace(
    "admin",
    [{ subject: { type: "user", id: "alice" }, object: trino, effect: "allow" }],
    "root",
  );
  await call("alice");
  assert.equal((fake.queries as Array<{ principal: string }>).at(-1)!.principal, "alice");
  await assert.rejects(call("bob"), { code: "entitlement_denied" });
  // A project deny narrows alice inside that project only.
  await ent.replace({ projectId: "p1" }, [{ object: trino, effect: "deny" }], "alice");
  await assert.rejects(call("alice", "c-alice-p"), (e: { message: string }) =>
    /disabled by your admin/.test(e.message),
  );
  await call("alice");
});

test("github_create_pr: with entitlements the publish permit follows the entitlement", async () => {
  const config = publishConfigFromEnv(
    { GITHUB_PUBLISH_APP_ID: "1", GITHUB_PUBLISH_KEY_FILE: "/k", GITHUB_PUBLISH_REPOS: "acme/app" },
    { ownersOptional: true },
  )!;
  assert.ok(config);
  assert.equal(
    publishConfigFromEnv({
      GITHUB_PUBLISH_APP_ID: "1",
      GITHUB_PUBLISH_KEY_FILE: "/k",
      GITHUB_PUBLISH_REPOS: "acme/app",
    }),
    undefined,
  );
  const ent = await new Entitlements(new MemoryRules()).load();
  const tool = githubCreatePrTool({
    config,
    publisher: new GitHubPublisher(config),
    readChanges: async () => "",
    ownerAllowed: (o) => ent.allowed(o, pr),
  });
  const d = { kind: "github" as const, target: "acme/app@linguini/*", crossesBoundary: true };
  const ctx = { owner: "alice", conversationId: "c", sensitive: false };
  assert.equal(tool.permit!(d, ctx), false);
  await ent.replace("admin", [{ subject: { type: "org" }, object: pr, effect: "allow" }], "root");
  assert.equal(tool.permit!(d, ctx), true);
  assert.equal(tool.permit!({ ...d, target: "acme/other@linguini/*" }, ctx), false);
});

test("HTTP: /api/me/entitlements; admin route 404 for non-admins; project rules by owners, deny only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ent-http-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ent = await new Entitlements(new MemoryRules(), { publish: ["alice"] }).load();
  const projects = new ProjectService(new MemoryProjects(), {
    store,
    invites: true,
    newId: () => "p1",
    lookupUser: async (x) => x.userId,
  });
  await projects.create("alice", { name: "P" });
  await projects.invite("alice", "p1", { userId: "bob", role: "editor" });
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
  const tok = (u: string) => `${u}-`.padEnd(40, "t");
  const { server, closeStreams } = api(
    engine,
    { [tok("alice")]: "alice", [tok("bob")]: "bob" },
    undefined,
    {
      projects,
      entitlements: ent,
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    closeStreams();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${tok(who)}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const me = await call("alice", "GET", "/api/me/entitlements");
  assert.deepEqual(
    me.body.tools.map((x: { name: string; status: string }) => [x.name, x.status]),
    [
      ["trino_query", "not-enabled"],
      ["github_create_pr", "enabled"],
    ],
  );
  assert.equal((await call("alice", "GET", "/api/admin/entitlements")).status, 404);
  assert.equal((await call("alice", "PUT", "/api/admin/entitlements", { rules: [] })).status, 404);
  const deny = { rules: [{ object: pr, effect: "deny" }] };
  assert.equal((await call("bob", "PUT", "/api/projects/p1/entitlements", deny)).status, 403);
  assert.equal(
    (
      await call("alice", "PUT", "/api/projects/p1/entitlements", {
        rules: [{ object: pr, effect: "allow" }],
      })
    ).status,
    400,
  );
  assert.equal((await call("alice", "PUT", "/api/projects/p1/entitlements", deny)).status, 200);
  assert.deepEqual((await call("bob", "GET", "/api/projects/p1/entitlements")).body.rules, [
    { subject: { type: "project", id: "p1" }, object: pr, effect: "deny" },
  ]);
  assert.equal(ent.allowed("alice", pr, "p1"), false);
  assert.equal((await call("carol", "GET", "/api/projects/p1/entitlements")).status, 401);
});

const database = process.env.TEST_DATABASE_URL;
test("PostgresRules: replace by scope, removeUser", { skip: !database }, async (t) => {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: database!, max: 2 });
  t.after(() => pool.end());
  await createAuth({ secret: randomBytes(32).toString("hex"), baseURL: "http://localhost", pool });
  const rules = await PostgresRules.open(pool);
  await pool.query("DELETE FROM prototype_entitlements");
  const e = await new Entitlements(rules).load();
  await e.replace(
    "admin",
    [
      { subject: { type: "org" }, object: trino, effect: "deny" },
      { subject: { type: "user", id: "u1" }, object: pr, effect: "allow" },
    ],
    "root",
  );
  await e.replace({ projectId: "p9" }, [{ object: pr, effect: "deny" }], "u1");
  const fresh = await new Entitlements(rules).load();
  assert.equal(fresh.allowed("u1", pr), true);
  assert.equal(fresh.allowed("u1", pr, "p9"), false);
  assert.equal(fresh.decide("u1", trino).reason, "org-deny");
  // Replacing the admin set leaves project rules alone.
  await fresh.replace("admin", [], "root");
  assert.equal(fresh.projectRules("p9").length, 1);
  await fresh.replace(
    "admin",
    [{ subject: { type: "user", id: "u1" }, object: pr, effect: "allow" }],
    "root",
  );
  await fresh.removeUser("u1");
  assert.equal(fresh.allowed("u1", pr), false);
  await pool.query("DELETE FROM prototype_entitlements");
});
