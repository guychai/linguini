// Admin basics (AUTH_MODE=better-auth): ADMIN_EMAILS bootstrap, /api/admin/* authz (404 for
// everyone but admins), account deletion that leaves no trace of the user's data, and password
// resets that revoke the user's sessions. Real Better Auth, real stores, real ConversationDeleter
// over fake compute / network / S3 targets and a real egress policy directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PostgresStore, SqliteStore, type Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { api } from "./api.ts";
import type { Harness, Sink } from "./harness.ts";
import { MemorySettings, PostgresSettings, settingsPolicyFromEnv } from "./users.ts";
import { createAuth, type AdminAuth } from "./auth.ts";
import { ConversationDeleter } from "./deletion.ts";
import { FileEgressPolicyWriter, handsKey } from "./hands.ts";
import { AccountAdmin } from "./accounts.ts";
import { PostgresPreviewPorts } from "./preview.ts";

const SECRET = randomBytes(32).toString("hex");
const database = process.env.TEST_DATABASE_URL;
const PW = "correct horse battery";

function fakes() {
  const jobs = new Set<string>();
  const nets = new Set<string>();
  const objects = new Map<string, string>();
  return {
    jobs,
    nets,
    objects,
    nomad: {
      purge: async (id: string) => void jobs.delete(id),
      jobIds: async (p: string) => [...jobs].filter((j) => j.startsWith(p)),
    },
    network: { release: async (k: string) => void nets.delete(k) },
    snapshots: {
      list: async (p: string) =>
        [...objects]
          .filter(([k]) => k.startsWith(p))
          .map(([key, lastModified]) => ({ key, lastModified })),
      delete: async (k: string) => void objects.delete(k),
    },
  };
}

async function rig(t: { after: (f: () => unknown) => void }, kind: "sqlite" | "postgres") {
  const dir = await mkdtemp(join(tmpdir(), "adm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store: Store =
    kind === "sqlite"
      ? new SqliteStore(join(dir, "s.sqlite"))
      : await PostgresStore.open(database!);
  t.after(() => store.close());
  const sfx = randomUUID().slice(0, 8);
  const adminEmail = `admin-${sfx}@x.example`;
  let pool: import("pg").Pool | undefined;
  if (kind === "postgres") {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: database!, max: 2 });
    t.after(() => pool!.end());
  }
  const auth = await createAuth({
    secret: SECRET,
    baseURL: "http://localhost",
    adminEmails: [adminEmail.toUpperCase()],
    ...(pool ? { pool } : {}),
  });
  const settings = pool ? await PostgresSettings.open(pool) : new MemorySettings();
  const ports = kind === "postgres" ? await PostgresPreviewPorts.open(database!) : undefined;
  const engine = new Engine(
    store,
    async (): Promise<Harness> => ({
      async run(_text: string, _h: string, emit: Sink) {
        await emit("assistant.delta", { text: "ok" });
      },
      async steer() {},
      async abort() {},
      dispose() {},
    }),
    { heartbeatMs: 0, worker: "W" },
  );
  const f = fakes();
  const policies = join(dir, "policies");
  const local: string[] = [];
  const deleter = new ConversationDeleter(
    store,
    {
      ...f,
      policies: new FileEgressPolicyWriter(policies),
      local: async (o, i) => {
        local.push(`${o} ${i}`);
        await engine.forget(o, i);
      },
    },
    { networkRetries: 0 },
  );
  const accounts = new AccountAdmin(auth.admin, store, deleter, settings);
  const token = "t".repeat(40);
  const { server, closeStreams } = api(engine, { [token]: "service-owner" }, undefined, {
    auth: {
      auth,
      settings,
      policy: settingsPolicyFromEnv({ PI_MODEL: "m1" }),
      accounts,
    },
    deleter,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    closeStreams();
    server.close();
    await engine.stop();
  });
  const as = (who: string | null, path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      headers: {
        "content-type": "application/json",
        ...(who ? { cookie: who } : {}),
        // What Linguini's own web client sends (see browserRequestAllowed).
        "sec-fetch-site": "same-origin",
        "x-linguini-client": "1",
        ...(init.method && init.method !== "GET"
          ? {
              origin: path.startsWith("/api/auth/")
                ? "http://localhost"
                : `http://127.0.0.1:${port}`,
            }
          : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const cookieOf = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("linguini.session_token="));
  const signUp = async (email: string) => {
    const r = await as(null, "/api/auth/sign-up/email", {
      method: "POST",
      json: { email, password: PW, name: email.split("@")[0] },
    });
    assert.equal(r.status, 200, await r.clone().text());
    const cookie = cookieOf(r)!;
    const s = (await (await as(cookie, "/api/session")).json()) as {
      user: { id: string; admin: boolean };
    };
    return { cookie, id: s.user.id, admin: s.user.admin, email };
  };
  const signIn = async (email: string, password: string) => {
    const r = await as(null, "/api/auth/sign-in/email", {
      method: "POST",
      json: { email, password },
    });
    return { status: r.status, cookie: cookieOf(r) };
  };
  /** A conversation with a running sandbox: job, network, policy file, two S3 objects. */
  const seed = async (cookie: string, owner: string, title: string) => {
    const id = `conv-${randomUUID()}`;
    assert.equal(
      (
        await as(cookie, "/api/conversations", {
          method: "POST",
          json: { id, title },
        })
      ).status,
      201,
    );
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
    f.jobs.add(`hands-${key}-g1`).add(`hands-${key}-g2`);
    f.nets.add(key);
    f.objects.set(`sandboxes/ws-${key}/workspace.tar.gz`, new Date().toISOString());
    f.objects.set(
      `sandboxes/ws-${key}/workspace.after-failed-restore-g2.tar.gz`,
      new Date().toISOString(),
    );
    await new FileEgressPolicyWriter(policies).apply({
      version: 1,
      conversationKey: key,
      workspaceId: `ws-${key}`,
      tainted: false,
      rules: [],
    });
    await ports?.share(owner, id, { port: 3000 });
    return { id, key };
  };
  const traces = async (key: string) => ({
    jobs: [...f.jobs].filter((j) => j.includes(key)),
    nets: [...f.nets].filter((n) => n === key),
    objects: [...f.objects.keys()].filter((o) => o.includes(key)),
    policies: (await readdir(policies).catch(() => [] as string[])).filter((p) =>
      p.startsWith(key),
    ),
  });
  return {
    as,
    signUp,
    signIn,
    seed,
    traces,
    store,
    settings,
    pool,
    ports,
    adminEmail,
    token,
    local,
    sfx,
  };
}

for (const kind of ["sqlite", "postgres"] as const)
  test(
    `${kind}: admin API is 404 for non-admins; account deletion leaves no trace; reset revokes sessions`,
    { skip: kind === "postgres" && !database, timeout: 60_000 },
    async (t) => {
      const r = await rig(t, kind);
      const admin = await r.signUp(r.adminEmail);
      const alice = await r.signUp(`alice-${r.sfx}@x.example`);
      const bob = await r.signUp(`bob-${r.sfx}@x.example`);
      assert.equal(admin.admin, true, "ADMIN_EMAILS (case-insensitive) makes the account an admin");
      assert.equal(alice.admin, false);

      // ---- authz: the admin API does not exist for anyone but admins ----
      for (const [who, label] of [
        [alice.cookie, "user"],
        [null, "anonymous"],
      ] as const) {
        for (const [method, path] of [
          ["GET", "/api/admin/users"],
          ["DELETE", `/api/admin/users/${bob.id}`],
          ["POST", `/api/admin/users/${bob.id}/password`],
        ] as const) {
          const res = await r.as(who, path, {
            method,
            ...(method === "POST" ? { json: {} } : {}),
          });
          assert.equal(
            res.status,
            who ? 404 : 401,
            `${await res.clone().text()} ` + `${label} ${method} ${path}`,
          );
        }
      }
      const service = await r.as(null, "/api/admin/users", {
        headers: { authorization: `Bearer ${r.token}` },
      });
      assert.equal(service.status, 404, "service bearer tokens are not admins");
      // The plugin's own routes are not exposed, not even to admins.
      for (const who of [admin.cookie, alice.cookie]) {
        assert.equal((await r.as(who, "/api/auth/admin/list-users")).status, 404);
        assert.equal(
          (
            await r.as(who, "/api/auth/admin/set-role", {
              method: "POST",
              json: { userId: alice.id, role: "admin" },
            })
          ).status,
          404,
        );
      }
      assert.equal(
        (await r.as(alice.cookie, "/api/session").then((x) => x.json())).user.admin,
        false,
      );

      // ---- data ----
      const a1 = await r.seed(alice.cookie, alice.id, "alice one");
      const a2 = await r.seed(alice.cookie, alice.id, "alice two");
      const b1 = await r.seed(bob.cookie, bob.id, "bob one");
      // A conversation alice deleted whose cleanup never finished (tombstone, artifacts left).
      const a3 = await r.seed(alice.cookie, alice.id, "alice half-deleted");
      await r.store.mutate(alice.id, a3.id, (c) => void (c.deletedAt = new Date().toISOString()));
      assert.equal(
        (
          await r.as(alice.cookie, "/api/me/settings", {
            method: "PUT",
            json: { prefs: { theme: "x" } },
          })
        ).status,
        200,
      );

      const list = (await (await r.as(admin.cookie, "/api/admin/users")).json()) as {
        users: Array<{
          id: string;
          email: string;
          role: string;
          conversations: number;
          runningSandboxes: number;
          lastActiveAt: string | null;
          createdAt: string;
        }>;
      };
      const row = list.users.find((u) => u.id === alice.id)!;
      assert.equal(row.email, alice.email);
      assert.equal(row.role, "user");
      assert.equal(row.conversations, 2, "tombstoned conversations are not counted");
      assert.equal(row.runningSandboxes, 2);
      assert.ok(row.lastActiveAt && row.createdAt);
      assert.equal(list.users.find((u) => u.id === admin.id)!.role, "admin");
      assert.ok(!JSON.stringify(list).match(/password|hash|token/i), "no secrets in the list");

      // ---- guards ----
      assert.equal(
        (
          await r.as(admin.cookie, `/api/admin/users/${admin.id}`, {
            method: "DELETE",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await r.as(admin.cookie, `/api/admin/users/nope`, {
            method: "DELETE",
          })
        ).status,
        404,
      );

      // ---- delete alice ----
      const del = await r.as(admin.cookie, `/api/admin/users/${alice.id}`, {
        method: "DELETE",
      });
      assert.equal(del.status, 200, await del.clone().text());
      const report = (await del.json()) as {
        conversations: number;
        jobs: number;
        objects: number;
        pending: number;
      };
      assert.deepEqual(
        {
          c: report.conversations,
          j: report.jobs,
          o: report.objects,
          p: report.pending,
        },
        { c: 3, j: 6, o: 6, p: 0 },
      );
      for (const c of [a1, a2, a3]) {
        assert.deepEqual(
          await r.traces(c.key),
          { jobs: [], nets: [], objects: [], policies: [] },
          c.id,
        );
        if (r.ports) assert.deepEqual(await r.ports.list(alice.id, c.id), []);
      }
      assert.deepEqual(
        (await r.store.refs()).filter((x) => x.owner === alice.id),
        [],
      );
      assert.ok(
        r.local.some((l) => l === `${alice.id} ${a1.id}`),
        "in-process run state dropped",
      );
      assert.equal(
        (await r.as(alice.cookie, "/api/session")).status,
        401,
        "alice's session is gone",
      );
      assert.equal((await r.signIn(alice.email, PW)).status, 401, "alice cannot sign in");
      if (r.settings instanceof MemorySettings) assert.equal(r.settings.has(alice.id), false);
      if (r.pool) {
        for (const [table, col] of [
          ['"user"', "id"],
          ["session", '"userId"'],
          ["account", '"userId"'],
          ["prototype_user_settings", "user_id"],
        ])
          assert.equal(
            (
              await r.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col}=$1`, [
                alice.id,
              ])
            ).rows[0].n,
            0,
            table,
          );
        assert.equal(
          (
            await r.pool.query(
              "SELECT count(*)::int AS n FROM prototype_events e JOIN (SELECT unnest($1::text[]) id) x ON e.conversation_id = x.id",
              [[a1.id, a2.id, a3.id]],
            )
          ).rows[0].n,
          0,
          "journal",
        );
      }
      // Bob untouched.
      const bt = await r.traces(b1.key);
      assert.equal(bt.jobs.length, 2);
      assert.equal(bt.objects.length, 2);
      assert.equal(bt.policies.length, 1);
      assert.equal((await r.as(bob.cookie, `/api/conversations/${b1.id}`)).status, 200);
      const after = (await (await r.as(admin.cookie, "/api/admin/users")).json()) as {
        users: Array<{ id: string }>;
      };
      assert.ok(!after.users.some((u) => u.id === alice.id));
      assert.equal(
        (
          await r.as(admin.cookie, `/api/admin/users/${alice.id}`, {
            method: "DELETE",
          })
        ).status,
        404,
      );

      // ---- password reset ----
      assert.equal(
        (
          await r.as(admin.cookie, `/api/admin/users/${bob.id}/password`, {
            method: "POST",
            json: { password: "short" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await r.as(admin.cookie, `/api/admin/users/${admin.id}/password`, {
            method: "POST",
            json: {},
          })
        ).status,
        400,
      );
      const reset = await r.as(admin.cookie, `/api/admin/users/${bob.id}/password`, {
        method: "POST",
        json: {},
      });
      assert.equal(reset.status, 200);
      const { password: temp } = (await reset.json()) as { password: string };
      assert.ok(temp && temp.length >= 12);
      assert.equal(
        (await r.as(bob.cookie, "/api/session")).status,
        401,
        "bob's sessions are revoked",
      );
      assert.equal((await r.signIn(bob.email, PW)).status, 401, "old password refused");
      const bobNew = await r.signIn(bob.email, temp);
      assert.equal(bobNew.status, 200);
      // Bob changes his own password (Better Auth change-password).
      const ch = await r.as(bobNew.cookie!, "/api/auth/change-password", {
        method: "POST",
        json: {
          currentPassword: temp,
          newPassword: "bob's own password",
          revokeOtherSessions: true,
        },
      });
      assert.equal(ch.status, 200, await ch.clone().text());
      assert.equal((await r.signIn(bob.email, "bob's own password")).status, 200);
      const set = await r.as(admin.cookie, `/api/admin/users/${bob.id}/password`, {
        method: "POST",
        json: { password: "chosen by admin" },
      });
      assert.deepEqual(await set.json(), {}, "a chosen password is not echoed");
      assert.equal((await r.signIn(bob.email, "chosen by admin")).status, 200);
      // Bob's data survived all of it.
      assert.equal((await r.store.refs()).filter((x) => x.owner === bob.id).length, 1);
      if (r.pool)
        await r.pool
          .query(`DELETE FROM "user" WHERE id = ANY($1)`, [[admin.id, bob.id]])
          .catch(() => {});
    },
  );

test("last admin cannot be deleted; delete keeps going when one conversation's cleanup fails", async () => {
  const users = [
    {
      id: "a1",
      email: "a1@x",
      name: "A1",
      role: "admin",
      createdAt: "",
      lastActiveAt: null,
    },
    {
      id: "a2",
      email: "a2@x",
      name: "A2",
      role: "admin",
      createdAt: "",
      lastActiveAt: null,
    },
    {
      id: "u",
      email: "u@x",
      name: "U",
      role: "user",
      createdAt: "",
      lastActiveAt: null,
    },
  ];
  const calls: string[] = [];
  const fake: AdminAuth = {
    listUsers: async () => users,
    lockOut: async (_r, id) => void calls.push(`lockOut ${id}`),
    removeUser: async (_r, id) => void calls.push(`remove ${id}`),
    setPassword: async () => {},
  };
  const refs = [
    { owner: "u", id: "c1" },
    { owner: "u", id: "c2" },
  ];
  const acct = new AccountAdmin(
    fake,
    { refs: async () => refs },
    {
      tombstone: async () => {},
      finish: async (_o, id) => {
        if (id === "c1") throw new Error("nomad down");
        refs.splice(
          refs.findIndex((r) => r.id === id),
          1,
        );
        return {
          owner: "u",
          id,
          jobs: ["j"],
          network: true,
          policy: true,
          objects: ["o"],
          rows: true,
        };
      },
    },
    { deleteSettings: async (id) => void calls.push(`settings ${id}`) },
  );
  const req = {} as IncomingMessage;
  // An admin outside the list (e.g. promoted elsewhere) deleting the only remaining admin.
  users.splice(1, 1);
  await assert.rejects(acct.deleteUser(req, "other", "a1"), { status: 409 });
  const rep = await acct.deleteUser(req, "a1", "u");
  // c1 failed in both passes; it stays tombstoned for the sweeper.
  assert.deepEqual({ c: rep.conversations, p: rep.pending }, { c: 1, p: 2 });
  assert.deepEqual(calls, ["lockOut u", "settings u", "remove u"]);
  await assert.rejects(acct.deleteUser(req, "a1", "a1"), { status: 400 });
  await assert.rejects(acct.resetPassword(req, "a1", "u", 12345), {
    status: 400,
  });
});
