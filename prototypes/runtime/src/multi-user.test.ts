// Multi-user (AUTH_MODE=better-auth): real Better Auth accounts and session cookies, and
// cross-user isolation. User B must not be able to list, read, stream, send to, settle, delete,
// open a terminal on, browse files of, or reach previews of user A's conversation; foreign ids
// look exactly like missing ones (404, never 403).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { SqliteStore, PostgresStore, type Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { api } from "./api.ts";
import type { Harness, Sink } from "./harness.ts";
import {
  MemorySettings,
  PostgresSettings,
  effectiveModel,
  settingsPolicyFromEnv,
  validateSettings,
} from "./users.ts";
import { createAuth, type LinguiniAuth } from "./auth.ts";
import { GRANT_COOKIE, MemoryPreviewPorts, PreviewActivity, PreviewProxy } from "./preview.ts";
import { sandboxQuota } from "./hands.ts";
import { ApiError } from "./store.ts";

const SECRET = randomBytes(32).toString("hex");

test("settings: only prefs are per user; model and thinking level are the server's", () => {
  const policy = settingsPolicyFromEnv({ PI_MODEL: "m1", ALLOWED_MODELS: "m2, m3" });
  const theme = { "t3code:theme": "grove", "t3code:theme-appearance-mode": "dark" };
  assert.deepEqual(validateSettings({ prefs: { theme } }, {}, policy), { prefs: { theme } });
  assert.deepEqual(validateSettings({ prefs: null }, { prefs: { theme } }, policy), {});
  // A model/thinking override stored before the lock is dropped on the next save.
  assert.deepEqual(validateSettings({}, { model: "m2", thinkingLevel: "high" }, policy), {});
  for (const bad of [{ model: "m1" }, { thinkingLevel: "high" }, { owner: "x" }, { prefs: [] }])
    assert.throws(
      () => validateSettings(bad, {}, policy),
      (e) => (e as ApiError).status === 400,
      JSON.stringify(bad),
    );
  assert.throws(
    () => validateSettings({ prefs: { x: "y".repeat(130_000) } }, {}, policy),
    (e) => (e as ApiError).status === 413,
  );
  assert.deepEqual(effectiveModel({ model: "m2", thinkingLevel: "high" }, policy), {
    model: undefined,
    thinkingLevel: undefined,
  });
});

test("quota: a user's running sandboxes are capped; other users and this conversation don't count", async () => {
  const rows = [
    { id: "a1", hands: { state: "ready" } },
    { id: "a2", hands: { state: "allocating" } },
    { id: "a3", hands: { state: "stopped" } },
    { id: "a4", hands: null },
  ];
  const store = {
    list: async (owner: string) => ({
      items: owner === "A" ? rows : [{ id: "b1", hands: { state: "ready" } }],
      next: null,
    }),
  } as never;
  await sandboxQuota(store, 3)("A", "a4");
  await assert.rejects(
    sandboxQuota(store, 2)("A", "a4"),
    (e) =>
      (e as ApiError).status === 429 &&
      (e as ApiError).code === "sandbox_quota" &&
      /limit 2/.test((e as Error).message),
  );
  await sandboxQuota(store, 2)("A", "a1"); // a1 is already running: restarting it is not a new one
  await sandboxQuota(store, 1)("B", "b1");
  await assert.rejects(sandboxQuota(store, 1)("B", "b2"));
  await sandboxQuota(store, 0)("A", "x"); // 0 disables
});

async function rig(
  t: { after: (f: () => unknown) => void },
  store: Store,
  o: { auth?: LinguiniAuth; settings?: MemorySettings | PostgresSettings; webDist?: string } = {},
) {
  const auth = o.auth ?? (await createAuth({ secret: SECRET, baseURL: "http://localhost" }));
  const settings = o.settings ?? new MemorySettings();
  const prompts: string[] = [];
  const engine = new Engine(
    store,
    async (): Promise<Harness> => ({
      async run(text: string, _h: string, emit: Sink) {
        prompts.push(text);
        await emit("assistant.delta", { text: "ok" });
      },
      async steer() {},
      async abort() {},
      dispose() {},
    }),
    { heartbeatMs: 0, worker: "W" },
  );
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...a: unknown[]) => {
      calls.push(`${name} ${a.slice(0, 2).join(" ")}`);
      return Promise.resolve({ entries: [], truncated: false });
    };
  const files = {
    list: record("files.list"),
    read: record("files.read"),
    search: record("files.search"),
    write: record("files.write"),
  };
  const deleter = {
    tombstone: async (o: string, i: string) => {
      await engine.store.snapshot(o, i, { events: false }); // the real deleter is owner-scoped too
      calls.push(`delete ${o} ${i}`);
      return { jobs: [] };
    },
    finish: async () => ({ jobs: [], network: false, policy: false, objects: [], rows: true }),
  };
  const termListeners: string[] = [];
  const terminals = {
    open: async (o: string, i: string) => (calls.push(`term.open ${o} ${i}`), {}),
    write: (o: string, i: string) => calls.push(`term.write ${o} ${i}`),
    resize() {},
    clear() {},
    restart: async () => ({}),
    close() {},
    subscribeMetadata: (o: string) => (termListeners.push(`meta ${o}`), () => {}),
    subscribeEvents: (o: string) => (termListeners.push(`events ${o}`), () => {}),
    attach: async (o: string, i: string) => (calls.push(`term.attach ${o} ${i}`), () => {}),
  };
  const ports = new MemoryPreviewPorts();
  const upstreamSeen: IncomingMessage["headers"][] = [];
  const upstream = createServer((q, r) => {
    upstreamSeen.push(q.headers);
    r.setHeader("set-cookie", [
      "linguini.session_token=evil; Path=/",
      "__Secure-linguini.session_token=evil; Path=/; Secure",
      "app=1; Path=/",
    ]);
    r.end("preview body of A");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;
  const token = "t".repeat(40);
  const grantKey = randomBytes(32);
  const { server, closeStreams } = api(engine, { [token]: "service-owner" }, o.webDist, {
    auth: {
      auth,
      settings,
      policy: settingsPolicyFromEnv({ PI_MODEL: "m1", ALLOWED_MODELS: "m2" }),
    },
    files,
    deleter,
    terminals: terminals as never,
    previews: {
      ports,
      share: async (o: string, i: string, args: Record<string, unknown>) => (
        calls.push(`share ${o} ${i}`),
        ports.share(o, i, { port: Number(args.port) })
      ),
      proxy: (resolveOwner: (r: IncomingMessage) => Promise<string | undefined>) =>
        new PreviewProxy({
          ports,
          activity: new PreviewActivity(),
          targets: { address: async () => "127.0.0.1" },
          conversationExists: (o, i) =>
            engine.store.snapshot(o, i, { events: false }).then(() => {}),
          resolveOwner,
          grantKey,
          allowTarget: () => true,
        }),
    },
  } as never);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    closeStreams();
    server.close();
    upstream.close();
    await engine.stop();
  });
  /** `who` is a session cookie header ("name=value"), or null for anonymous. */
  const as = (who: string | null, path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      headers: {
        "content-type": "application/json",
        ...(who ? { cookie: who } : {}),
        // What a browser on the app sends with Better Auth's POSTs.
        ...(path.startsWith("/api/auth/") && init.method === "POST"
          ? { origin: "http://localhost" }
          : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  /** A real Better Auth account through /api/auth/sign-up/email; returns its session cookie. */
  const signUp = async (email: string, name = email.split("@")[0]!) => {
    const r = await as(null, "/api/auth/sign-up/email", {
      method: "POST",
      json: { email, password: "correct horse battery", name },
    });
    assert.equal(r.status, 200, await r.clone().text());
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("linguini.session_token="));
    assert.ok(cookie, "session cookie set");
    const session = (await (await as(cookie, "/api/session")).json()) as {
      owner: string;
      user: { id: string; email: string; name: string };
    };
    assert.equal(session.user.email, email);
    assert.equal(session.owner, session.user.id, "owner = Better Auth user id");
    return { cookie, id: session.user.id };
  };
  return {
    as,
    signUp,
    port,
    calls,
    termListeners,
    engine,
    ports,
    upstreamPort,
    upstreamSeen,
    prompts,
    token,
  };
}

for (const kind of ["sqlite", "postgres"] as const) {
  const database = process.env.TEST_DATABASE_URL;
  test(
    `${kind}: user B cannot see or touch user A's conversation (404 everywhere)`,
    { skip: kind === "postgres" && !database, timeout: 30_000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "mu-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const store: Store =
        kind === "sqlite"
          ? new SqliteStore(join(dir, "s.sqlite"))
          : await PostgresStore.open(database!);
      t.after(() => store.close());
      let pgAuth: { auth: LinguiniAuth; settings: PostgresSettings } | undefined;
      if (kind === "postgres") {
        const { default: pg } = await import("pg");
        const pool = new pg.Pool({ connectionString: database!, max: 2 });
        t.after(() => pool.end());
        const auth = await createAuth({ secret: SECRET, baseURL: "http://localhost", pool });
        pgAuth = { auth, settings: await PostgresSettings.open(pool) };
      }
      const r = await rig(t, store, pgAuth ?? {});
      const alice = await r.signUp(`alice-${randomUUID()}@example.com`, "Alice");
      const bob = await r.signUp(`bob-${randomUUID()}@example.com`, "Bob");
      const A = alice.cookie,
        B = bob.cookie;
      assert.notEqual(alice.id, bob.id);
      const id = `conv-${randomUUID()}`;
      // B subscribes to change notifications before A does anything.
      const changesB = await r.as(B, "/api/changes");
      const readerB = changesB.body!.getReader();
      const seenB: string[] = [];
      void (async () => {
        for (;;) {
          const { value, done } = await readerB
            .read()
            .catch(() => ({ value: undefined, done: true }));
          if (done) return;
          seenB.push(new TextDecoder().decode(value));
        }
      })();
      assert.equal(
        (await r.as(A, "/api/conversations", { method: "POST", json: { id, title: "A's secret" } }))
          .status,
        201,
      );
      assert.ok(
        (
          await r.as(A, `/api/conversations/${id}/commands`, {
            method: "POST",
            json: { commandId: "c1", kind: "prompt", text: "hi" },
          })
        ).ok,
      );
      const ownerA = alice.id;
      await r.engine.idle(ownerA, id);
      // A sees it.
      assert.equal((await r.as(A, `/api/conversations/${id}`)).status, 200);
      assert.equal(((await (await r.as(A, "/api/conversations")).json()) as unknown[]).length, 1);
      await r.ports.share(ownerA, id, { port: r.upstreamPort });
      assert.equal((await r.as(A, `/preview/${id}/${r.upstreamPort}/`)).status, 200);
      const callsBefore = r.calls.length;
      // B sees nothing.
      assert.deepEqual(await (await r.as(B, "/api/conversations")).json(), []);
      const missing = `conv-${randomUUID()}`;
      const probes: Array<[string, string, unknown?]> = [
        ["GET", ""],
        ["GET", "/events?after=0"],
        ["POST", "/commands", { commandId: "x1", kind: "prompt", text: "steal" }],
        ["POST", "/metadata", { commandId: "m1", settle: "settled" }],
        ["POST", "/metadata", { commandId: "m2", title: "pwned" }],
        ["DELETE", ""],
        ["POST", "/files/list", { path: "" }],
        ["POST", "/files/read", { path: "a" }],
        ["POST", "/files/write", { path: "a", contents: "x", expectedVersion: "new" }],
        ["GET", "/previews"],
        ["POST", "/previews", { port: 3000 }],
        ["DELETE", "/previews/3000"],
        ["POST", `/ledger/x${"0".repeat(32)}/resolve`, { outcome: "applied" }],
      ];
      for (const [method, suffix, json] of probes) {
        const foreign = await r.as(B, `/api/conversations/${id}${suffix}`, {
          method,
          ...(json ? { json } : {}),
        });
        const absent = await r.as(B, `/api/conversations/${missing}${suffix}`, {
          method,
          ...(json ? { json } : {}),
        });
        assert.equal(foreign.status, 404, `${method} ${suffix} foreign`);
        assert.equal(absent.status, 404, `${method} ${suffix} absent`);
        assert.deepEqual(
          await foreign.json(),
          await absent.json(),
          `${method} ${suffix}: indistinguishable`,
        );
      }
      // Terminal HTTP: a foreign id answers exactly like a not-yet-started one (T3 draft threads).
      const term = await r.as(B, `/api/conversations/${id}/terminal/open`, {
        method: "POST",
        json: {},
      });
      const termAbsent = await r.as(B, `/api/conversations/${missing}/terminal/open`, {
        method: "POST",
        json: {},
      });
      assert.equal(term.status, termAbsent.status);
      assert.deepEqual(await term.json(), await termAbsent.json());
      // Preview proxy: 404 for B.
      assert.equal((await r.as(B, `/preview/${id}/${r.upstreamPort}/`)).status, 404);
      // Creating a conversation with A's id does not hijack it.
      assert.equal(
        (await r.as(B, "/api/conversations", { method: "POST", json: { id, title: "mine" } }))
          .status,
        404,
      );
      // Terminal WebSocket attach on A's id: B only ever gets the draft placeholder.
      const ws = new WebSocket(
        `ws://127.0.0.1:${r.port}/api/terminal-stream?kind=attach&threadId=${id}&terminalId=default`,
        {
          headers: { cookie: B },
        },
      );
      const first = await new Promise<string>((res, rej) => {
        ws.once("message", (d) => res(String(d)));
        ws.once("error", rej);
      });
      assert.match(first, /"status":"starting"/);
      ws.close();
      const wsMeta = new WebSocket(`ws://127.0.0.1:${r.port}/api/terminal-stream?kind=metadata`, {
        headers: { cookie: B },
      });
      await once(wsMeta, "open");
      wsMeta.close();
      const ownerB = bob.id;
      assert.ok(
        r.termListeners.includes(`meta ${ownerB}`) && !r.termListeners.includes(`meta ${ownerA}`),
        "terminal metadata subscription is B's own",
      );
      // No side effect reached any backend on B's behalf, and A's conversation is untouched.
      assert.deepEqual(r.calls.slice(callsBefore), []);
      const a = (await (await r.as(A, `/api/conversations/${id}`)).json()) as {
        title: string;
        metadata: Record<string, unknown>;
        jobs: unknown[];
      };
      assert.equal(a.title, "A's secret");
      assert.equal(a.jobs.length, 1, "B's prompt never queued");
      assert.deepEqual(r.prompts, ["hi"]);
      // B's change stream never named A's conversation.
      await r.as(A, `/api/conversations/${id}/metadata`, {
        method: "POST",
        json: { commandId: "m3", title: "renamed" },
      });
      await new Promise((res) => setTimeout(res, 300));
      assert.ok(seenB.length > 0, "B's stream is live");
      assert.ok(!seenB.join("").includes(id), "A's changes are not fanned out to B");
      await readerB.cancel();
      // Unauthenticated: API 401; a forged/old cookie is the same as none.
      for (const who of [null, "linguini.session_token=forged.value"]) {
        const anon = await r.as(who, "/api/conversations");
        assert.equal(anon.status, 401);
        assert.equal(((await anon.json()) as { code: string }).code, "unauthenticated");
      }
      const anonWs = new WebSocket(
        `ws://127.0.0.1:${r.port}/api/terminal-stream?kind=metadata`,
      );
      await new Promise<void>((res) => {
        anonWs.once("unexpected-response", (_q, resp) => {
          assert.equal(resp.statusCode, 401);
          res();
        });
        anonWs.once("open", () => assert.fail("anonymous terminal socket opened"));
      });
      // Sign-out ends the session everywhere.
      const out = await r.as(B, "/api/auth/sign-out", {
        method: "POST",
        json: {},
        headers: { origin: "http://localhost" },
      });
      assert.equal(out.status, 200, await out.clone().text());
      assert.equal((await r.as(B, "/api/conversations")).status, 401);
    },
  );
}

test("settings API: theme prefs per user; model/thinking refused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mu-s-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(() => store.close());
  const r = await rig(t, store);
  const a = (await r.signUp("a@x.example")).cookie;
  const b = (await r.signUp("b@x.example")).cookie;
  const put = (who: string, json: unknown) => r.as(who, "/api/me/settings", { method: "PUT", json });
  const theme = { "t3code:theme": "ember" };
  assert.equal((await put(a, { prefs: { theme } })).status, 200);
  assert.equal((await put(a, { model: "m2" })).status, 400);
  assert.equal((await put(a, { thinkingLevel: "low" })).status, 400);
  const sa = (await (await r.as(a, "/api/me/settings")).json()) as Record<string, any>;
  assert.deepEqual(sa.settings, { prefs: { theme } });
  assert.deepEqual(sa.effective, {});
  const sb = (await (await r.as(b, "/api/me/settings")).json()) as Record<string, any>;
  assert.deepEqual(sb.settings, {}, "settings are per user");
});

test("accounts: duplicate email and wrong password refused; SIGNUP_ENABLED=false closes sign-up", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mu-a-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(() => store.close());
  const r = await rig(t, store);
  await r.signUp("n@x.example");
  const dup = await r.as(null, "/api/auth/sign-up/email", {
    method: "POST",
    json: { email: "n@x.example", password: "another password", name: "x" },
  });
  assert.notEqual(dup.status, 200);
  const bad = await r.as(null, "/api/auth/sign-in/email", {
    method: "POST",
    json: { email: "n@x.example", password: "wrong password" },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.getSetCookie().length, 0);
  const good = await r.as(null, "/api/auth/sign-in/email", {
    method: "POST",
    json: { email: "n@x.example", password: "correct horse battery" },
  });
  assert.equal(good.status, 200);
  assert.deepEqual(await (await r.as(null, "/api/auth/linguini-config")).json(), {
    signupEnabled: true,
  });
  // Sign-up closed.
  const closed = await rig(t, new SqliteStore(join(dir, "c.sqlite")), {
    auth: await createAuth({ secret: SECRET, baseURL: "http://localhost", signupEnabled: false }),
  });
  const refused = await closed.as(null, "/api/auth/sign-up/email", {
    method: "POST",
    json: { email: "z@x.example", password: "correct horse battery", name: "z" },
  });
  assert.notEqual(refused.status, 200);
  assert.deepEqual(await (await closed.as(null, "/api/auth/linguini-config")).json(), {
    signupEnabled: false,
  });
  // Cross-origin auth posts are refused.
  const cross = await r.as(null, "/api/auth/sign-in/email", {
    method: "POST",
    json: { email: "n@x.example", password: "correct horse battery" },
    headers: { origin: "https://evil.example" },
  });
  assert.equal(cross.status, 403);
});

test("previews: session cookie never reaches the sandbox app; grant is scoped; sandbox can't set the session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mu-pv-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(() => store.close());
  const r = await rig(t, store);
  const a = await r.signUp("pa@x.example");
  const id = `conv-${randomUUID()}`;
  assert.equal(
    (await r.as(a.cookie, "/api/conversations", { method: "POST", json: { id, title: "p" } })).status,
    201,
  );
  await r.ports.share(a.id, id, { port: r.upstreamPort });
  const path = `/preview/${id}/${r.upstreamPort}/`;
  const page = await r.as(`${a.cookie}; lpv_app=1`, path);
  assert.equal(page.status, 200);
  const seen = r.upstreamSeen.at(-1)!;
  assert.equal(seen.cookie, "app=1", "only the preview's own cookies are forwarded");
  assert.ok(!JSON.stringify(seen).includes("session_token"));
  const set = page.headers.getSetCookie();
  // The app's attempts to set Linguini's session cookie come back renamed and path-scoped.
  assert.ok(!set.some((c) => /^(__Secure-)?linguini\./.test(c)), set.join(" | "));
  assert.ok(set.some((c) => c.startsWith("lpv_linguini.session_token=evil; Path=" + path)));
  const grant = set.find((c) => c.startsWith(`${GRANT_COOKIE}=`))!;
  assert.match(grant, new RegExp(`Path=${path}; .*HttpOnly`));
  const g = grant.split(";")[0]!;
  // Sandboxed (opaque-origin) subresource requests carry only the grant: allowed for that preview.
  assert.equal((await r.as(g, `${path}app.js`)).status, 200);
  assert.ok(!JSON.stringify(r.upstreamSeen.at(-1)).includes(GRANT_COOKIE), "grant not forwarded");
  // ... but the grant is not a session: no API, no other preview.
  assert.equal((await r.as(g, "/api/conversations")).status, 401);
  assert.equal((await r.as(g, `/preview/${id}/${r.upstreamPort + 1}/`)).status, 401);
  const tampered = g.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  assert.equal((await r.as(tampered, `${path}x`)).status, 401);
  // Preview pages cannot drive the API or the auth routes (opaque origin or preview Referer).
  const previewish: Record<string, string>[] = [
    { origin: "null" },
    { referer: `http://127.0.0.1:${r.port}${path}` },
  ];
  for (const headers of previewish) {
    assert.equal((await r.as(a.cookie, "/api/conversations", { headers })).status, 403);
    assert.equal(
      (
        await r.as(a.cookie, "/api/auth/sign-out", { method: "POST", json: {}, headers })
      ).status,
      403,
    );
    assert.equal((await r.as(a.cookie, "/api/auth/get-session", { headers })).status, 403);
  }
  assert.equal((await r.as(a.cookie, "/api/conversations")).status, 200, "session still valid");
});

test("static shell: served without a session (the app shows its own sign-in screen)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mu-w-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(dir, "web/assets"), { recursive: true });
  await writeFile(join(dir, "web/index.html"), "<html>app</html>");
  await writeFile(join(dir, "web/assets/a.js"), "1");
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(() => store.close());
  const r = await rig(t, store, { webDist: join(dir, "web") });
  assert.equal((await r.as(null, "/")).status, 200);
  assert.equal((await r.as(null, "/assets/a.js")).status, 200);
  assert.equal((await r.as(null, "/api/session")).status, 401);
  // Service tokens still work alongside sessions.
  const svc = await r.as(null, "/api/session", { headers: { authorization: `Bearer ${r.token}` } });
  assert.equal(((await svc.json()) as { owner: string }).owner, "service-owner");
});
