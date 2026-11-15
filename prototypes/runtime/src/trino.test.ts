// V1.2a trino_query (placeholder backend): per-user principal, sensitive flag before dispatch,
// typed impersonation errors without fallback, and the warehouse unreachable from sandboxes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { DurableHarness, DurableStore } from "./durable-harness.ts";
import { ruleCoversHost, validateEgressRules, validateOwnerEgressRules } from "./egress-rules.ts";
import { HostToolRegistry, type HostTool } from "./host-tools.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import { SqliteStore, initial, read } from "./store.ts";
import {
  FakeTrino,
  HttpTrinoClient,
  TrinoError,
  trinoHostTool,
  trinoHostsFromEnv,
  trinoPrincipal,
} from "./trino.ts";

test("principal: email local part, fails closed", () => {
  assert.equal(trinoPrincipal("Jane.Doe@corp.example"), "jane.doe");
  assert.equal(trinoPrincipal("a+b@x"), "a+b");
  for (const bad of [undefined, null, "", "no-at", "@corp", " @corp", "a b@corp", "x/y@corp"])
    assert.throws(
      () => trinoPrincipal(bad as never),
      (e: unknown) => e instanceof TrinoError && e.code === "no_principal",
      String(bad),
    );
});

async function setup(t: { after(f: () => unknown): void }, emails: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "trino-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const owner of ["alice", "bob", "nomail"]) await store.create(initial(`c-${owner}`, owner));
  const trino = new FakeTrino(new Set(["alice", "bob"]));
  const published: string[] = [];
  const seenTainted: boolean[] = [];
  const publish: HostTool = {
    policy: { replay: "non-idempotent", destination: "sandbox", egress: false },
    writes: ["github"],
    destinations: (call) => [
      { kind: "github", target: String(call.args.repo), crossesBoundary: true },
    ],
    handler: async (call) => (published.push(String(call.args.repo)), { text: "ok" }),
  };
  const tool = trinoHostTool({ client: trino, emailOf: async (owner) => emails[owner] });
  const broker = new SandboxBroker(store, new FixtureSandbox(), {
    hostTools: new HostToolRegistry({
      trino_query: {
        ...tool,
        handler: async (call, run) => {
          seenTainted.push((await read(store, run.owner, run.conversationId)).tainted === true);
          return tool.handler(call, run);
        },
      },
      publish,
    }),
  });
  return { dir, store, trino, broker, published, seenTainted };
}

test("trino_query: runs as the user, sensitive flag set before dispatch, later egress refused", async (t) => {
  const { store, trino, broker, published, seenTainted } = await setup(t, {
    alice: "alice@corp.example",
    bob: "bob@corp.example",
  });
  const r = await broker.execute("alice", "c-alice", {
    id: "q1",
    tool: "trino_query",
    args: { sql: "SELECT * FROM demo.orders LIMIT 2" },
  });
  assert.equal(
    r.text,
    "order_id\tcustomer\ttotal_usd\n1\tacme\t120.5\n2\tglobex\t75\n(2 rows, truncated)",
  );
  assert.deepEqual(seenTainted, [true]);
  assert.deepEqual(trino.queries, [
    { principal: "alice", sql: "SELECT * FROM demo.orders LIMIT 2" },
  ]);
  const c = await read(store, "alice", "c-alice");
  assert.equal(c.tainted, true);
  assert.ok(c.events.some((e) => e.type === "taint.changed"));
  await assert.rejects(
    broker.execute("alice", "c-alice", { id: "p1", tool: "publish", args: { repo: "acme/app" } }),
    /cannot write outside Linguini/,
  );
  await assert.rejects(
    broker.execute("alice", "c-alice", { id: "s1", tool: "share_port", args: { port: 3000 } }),
    /egress-capable/,
  );
  assert.deepEqual(published, []);
  // Bob's thread runs as bob.
  await broker.execute("bob", "c-bob", {
    id: "q1",
    tool: "trino_query",
    args: { sql: "show tables" },
  });
  assert.equal(trino.queries.at(-1)!.principal, "bob");
  assert.equal((await read(store, "bob", "c-bob")).tainted, true);
});

test("trino_query: no email or refused impersonation fails closed, never as the service user", async (t) => {
  const { store, trino, broker } = await setup(t, { alice: "carol@corp.example" });
  await assert.rejects(
    broker.execute("nomail", "c-nomail", {
      id: "q",
      tool: "trino_query",
      args: { sql: "show tables" },
    }),
    (e: { status?: number; code?: string }) => e.status === 403 && e.code === "trino_no_principal",
  );
  // The flag is set even though nothing ran: it only ever restricts.
  assert.equal((await read(store, "nomail", "c-nomail")).tainted, true);
  await assert.rejects(
    broker.execute("alice", "c-alice", {
      id: "q",
      tool: "trino_query",
      args: { sql: "show tables" },
    }),
    (e: { code?: string }) => e.code === "trino_impersonation_denied",
  );
  assert.deepEqual(trino.queries, []);
});

test("HttpTrinoClient: service user + X-Trino-User, no retry on refused impersonation, caps", async () => {
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = (pages: unknown[], status = 200) =>
    (async (url: URL | string, init?: RequestInit) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      });
      if (init?.method === "DELETE") return respond(204, {});
      return respond(status, pages.shift() ?? {});
    }) as typeof fetch;
  const client = (f: typeof fetch) =>
    new HttpTrinoClient({
      url: "https://trino.test",
      serviceUser: "svc",
      credential: async () => "not-a-real-secret",
      fetch: f,
    });
  const r = await client(
    fetcher([
      { columns: [{ name: "n" }], data: [[1], [2]], nextUri: "https://trino.test/v1/next/1" },
      { data: [[3], [4]], nextUri: "https://trino.test/v1/next/2" },
    ]),
  ).query("alice", "select n from t", { maxRows: 3, timeoutMs: 5000 });
  assert.deepEqual(r, { columns: ["n"], rows: [[1], [2], [3]], truncated: true });
  assert.equal(requests[0]!.headers["x-trino-user"], "alice");
  assert.equal(
    requests[0]!.headers.authorization,
    `Basic ${Buffer.from("svc:not-a-real-secret").toString("base64")}`,
  );
  assert.equal(requests.at(-1)!.method, "DELETE");
  requests.length = 0;
  await assert.rejects(
    client(
      fetcher(
        [{ error: { message: "Access Denied: User svc cannot impersonate user alice" } }],
        403,
      ),
    ).query("alice", "select 1", { maxRows: 10, timeoutMs: 5000 }),
    (e: unknown) => e instanceof TrinoError && e.code === "impersonation_denied",
  );
  assert.equal(requests.length, 1);
  assert.ok(requests.every((q) => q.headers["x-trino-user"] === "alice"));
});

test("egress: rules that admit the warehouse refuse startup", () => {
  const hosts = trinoHostsFromEnv({
    TRINO_URL: "https://trino.corp.example:8443",
    TRINO_DENY_HOSTS: "*.warehouse.corp, trino-backup.corp",
  });
  assert.deepEqual(hosts, ["trino.corp.example", "*.warehouse.corp", "trino-backup.corp"]);
  assert.ok(ruleCoversHost("trino.corp.example", "trino.corp.example"));
  assert.ok(ruleCoversHost("*.corp.example", "trino.corp.example"));
  assert.ok(ruleCoversHost("db.warehouse.corp", "*.warehouse.corp"));
  assert.ok(ruleCoversHost("*.corp", "*.warehouse.corp"));
  assert.ok(!ruleCoversHost("corp.example", "trino.corp.example"));
  assert.ok(!ruleCoversHost("registry.npmjs.org", "trino.corp.example"));
  assert.throws(
    () => validateEgressRules([{ host: "*.corp.example" }], "test", hosts),
    /admits trino.corp.example, which sandboxes may never reach/,
  );
  assert.throws(
    () => validateOwnerEgressRules({ alice: [{ host: "db.warehouse.corp" }] }, "test", hosts),
    /owner alice/,
  );
  assert.equal(validateEgressRules([{ host: "registry.npmjs.org" }], "test", hosts).length, 1);
});

test("Durable: the model's trino_query flags the thread before the query runs", async (t) => {
  const { dir, store, broker, seenTainted } = await setup(t, { alice: "alice@corp.example" });
  const f = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(f.provider);
  let result = "";
  f.setResponses([
    fauxAssistantMessage([fauxToolCall("trino_query", { sql: "SELECT * FROM demo.customers" })], {
      stopReason: "toolUse",
    }),
    (context) => {
      const last = context.messages.at(-1) as { content?: Array<{ text?: string }> };
      result = (last.content ?? []).map((b) => b.text ?? "").join("");
      return fauxAssistantMessage("done");
    },
  ]);
  const h = await DurableHarness.create({
    broker,
    owner: "alice",
    id: "c-alice",
    jobId: "j",
    store: new DurableStore(join(dir, "durable")),
    models,
    model: { provider: "faux", modelId: f.getModel().id },
    systemPrompt: "test",
  });
  try {
    await h.run("q", "", async () => undefined, new AbortController().signal);
  } finally {
    h.dispose();
  }
  assert.match(result, /acme\tus-east/);
  assert.deepEqual(seenTainted, [true]);
  assert.equal((await read(store, "alice", "c-alice")).tainted, true);
});
