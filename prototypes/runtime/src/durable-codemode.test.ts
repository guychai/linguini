// Durable code mode (on in own-main; PI_DURABLE_CODEMODE=0 turns it off): a script's nested tool
// calls pass the same gate as model calls (ledger, destinations, entitlements), and scripts see
// no Node globals, env, network or models. Needs TEST_DATABASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { DurableHarness, DurableStore, durableCallId, durableCodemode } from "./durable-harness.ts";
import { HostToolRegistry, type HostTool } from "./host-tools.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import { PostgresStore, initial, read } from "./store.ts";

const database = process.env.TEST_DATABASE_URL;
const skip = !database;

async function setup(t: { after(f: () => unknown): void }, codemode = true) {
  const store = await PostgresStore.open(database!);
  const pool = new pg.Pool({ connectionString: database!, max: 4 });
  t.after(async () => {
    await store.close();
    await pool.end();
  });
  const owner = `alice-${randomUUID()}`,
    id = randomUUID();
  await store.create(initial(id, owner));
  const calls: string[] = [];
  const secretRead: HostTool = {
    // Declared production (a ledger label; no taint).
    policy: { replay: "safe-read", destination: "production", egress: false },
    writes: [],
    destinations: () => [],
    handler: async () => (calls.push("secret_read"), { text: "row: s3cr3t" }),
    description: "Read a sensitive table",
    parameters: { type: "object", properties: {} },
  };
  const publish: HostTool = {
    policy: { replay: "non-idempotent", destination: "sandbox", egress: false },
    writes: ["github"],
    destinations: (call) => [
      { kind: "github", target: String(call.args.repo), crossesBoundary: true },
    ],
    handler: async () => (calls.push("publish"), { text: "published" }),
    description: "Publish to a repo",
    parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  };
  // The owner is not entitled to publish (entitlements.ts would say "not enabled").
  const broker = new SandboxBroker(store, new FixtureSandbox(), {
    hostTools: new HostToolRegistry({ secret_read: secretRead, publish }),
    entitled: (_c, tool) => {
      if (tool === "publish")
        throw Object.assign(new Error(`"publish" is not enabled for your account`), {
          status: 403,
          code: "entitlement_denied",
        });
    },
  });
  const f = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(f.provider);
  const results: string[] = [];
  const script = async (jobId: string, code: string) => {
    f.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      (context) => {
        const last = context.messages.at(-1) as any;
        results.push(
          last?.role === "toolResult"
            ? last.content.map((b: { text?: string }) => b.text ?? "").join("")
            : "",
        );
        return fauxAssistantMessage("ok");
      },
    ]);
    const h = await DurableHarness.create({
      broker,
      owner,
      id,
      jobId,
      store: new DurableStore(pool),
      models,
      model: { provider: "faux", modelId: f.getModel().id },
      systemPrompt: "test",
      ...(codemode ? { orchestrators: [durableCodemode()] } : {}),
    });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    try {
      await h.run(
        jobId,
        "",
        async (type, data) => void events.push({ type, data }),
        new AbortController().signal,
      );
    } finally {
      h.dispose();
    }
    return { result: results.at(-1) ?? "", events };
  };
  return { store, broker, calls, script, f, models, owner, id };
}

test(
  "nested calls go through the broker and the ledger like model calls",
  { skip, timeout: 30_000 },
  async (t) => {
    const { store, script, owner, id } = await setup(t);
    const { result, events } = await script(
      "n1",
      `await tools.write({ path: "a.txt", content: "from script" });
     return await tools.read({ path: "a.txt" });`,
    );
    assert.doesNotMatch(result, /Script failed/);
    assert.match(result, /from script/);
    const c = await read(store, owner, id);
    const entries = Object.values(c.ledger ?? {});
    assert.deepEqual(entries.map((e) => e.tool).sort(), ["read", "write"]);
    for (const e of entries) assert.ok(e.callId.startsWith(durableCallId("")), e.callId);
    assert.ok(events.some((e) => e.type === "tool.started" && e.data.tool === "write"));
  },
);

test(
  "nested calls pass the same gate: a refused nested call never runs; the script continues",
  { skip, timeout: 30_000 },
  async (t) => {
    const { calls, script } = await setup(t);
    const { result, events } = await script(
      "x1",
      `const row = await tools.secret_read({});
     try { await tools.publish({ repo: "acme/app" }); } catch (e) { return "refused: " + e.message; }
     return "published";`,
    );
    assert.match(result, /refused: .*not enabled for your account/);
    assert.ok(events.some((e) => e.type === "tool.blocked" && e.data.tool === "publish"));
    assert.deepEqual(calls, ["secret_read"]);
  },
);

test(
  "scripts get no Node globals, env, network, timers or models",
  { skip, timeout: 30_000 },
  async (t) => {
    const { script } = await setup(t);
    process.env.LINGUINI_TEST_SECRET = "must-not-leak";
    t.after(() => delete process.env.LINGUINI_TEST_SECRET);
    const { result } = await script(
      "g1",
      `return [typeof process, typeof require, typeof fetch, typeof setTimeout,
             typeof models, typeof globalThis.process, JSON.stringify(Object.keys(globalThis).filter(k => /env|secret/i.test(k)))].join(",");`,
    );
    assert.match(result, /undefined,undefined,undefined,undefined,undefined,undefined,\[\]/);
    assert.doesNotMatch(result, /must-not-leak/);
  },
);

test(
  "off switch: without the orchestrator there is no codemode tool",
  { skip, timeout: 30_000 },
  async (t) => {
    const { script, calls } = await setup(t, false);
    const { result } = await script("o1", `return await tools.secret_read({});`);
    assert.doesNotMatch(result, /s3cr3t/);
    assert.deepEqual(calls, []);
  },
);
