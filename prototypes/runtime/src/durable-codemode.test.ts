// V1.1.5b: Durable code mode, still off by default. These tests are the condition for ever turning
// it on: a script's nested tool calls pass the same gate as model calls, nested reads of
// sensitive sources flag the thread even when the script drops the data, and scripts see no
// Node globals, env, network or models.
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
import { DurableHarness, DurableStore, durableCallId, durableCodemode } from "./durable-harness.ts";
import { HostToolRegistry, type HostTool } from "./host-tools.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import { SqliteStore, initial, read } from "./store.ts";

async function setup(t: { after(f: () => unknown): void }, codemode = true) {
  const dir = await mkdtemp(join(tmpdir(), "durable-codemode-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await store.create(initial("c", "alice"));
  const calls: string[] = [];
  const secretRead: HostTool = {
    // Declared production: the broker sets the sensitive flag before the call runs.
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
  const broker = new SandboxBroker(store, new FixtureSandbox(), {
    hostTools: new HostToolRegistry({ secret_read: secretRead, publish }),
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
      owner: "alice",
      id: "c",
      jobId,
      store: new DurableStore(join(dir, "durable")),
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
  return { store, broker, calls, script, f, models, dir };
}

test(
  "nested calls go through the broker and the ledger like model calls",
  { timeout: 30_000 },
  async (t) => {
    const { store, script } = await setup(t);
    const { result, events } = await script(
      "n1",
      `await tools.write({ path: "a.txt", content: "from script" });
     return await tools.read({ path: "a.txt" });`,
    );
    assert.doesNotMatch(result, /Script failed/);
    assert.match(result, /from script/);
    const c = await read(store, "alice", "c");
    const entries = Object.values(c.ledger ?? {});
    assert.deepEqual(entries.map((e) => e.tool).sort(), ["read", "write"]);
    for (const e of entries) assert.ok(e.callId.startsWith(durableCallId("")), e.callId);
    assert.ok(events.some((e) => e.type === "tool.started" && e.data.tool === "write"));
  },
);

test(
  "a nested read of a sensitive source flags the thread even if the script drops it",
  { timeout: 30_000 },
  async (t) => {
    const { store, calls, script } = await setup(t);
    const { result } = await script(
      "s1",
      `await tools.secret_read({});
     store("kept", "nothing to see");
     return "done";`,
    );
    assert.match(result, /done/);
    assert.doesNotMatch(result, /s3cr3t/);
    assert.deepEqual(calls, ["secret_read"]);
    assert.equal((await read(store, "alice", "c")).tainted, true);
    // Later in the same script and in later scripts: boundary-crossing and egress calls refused.
    const second = await script(
      "s2",
      `const v = load("kept");
     try { await tools.publish({ repo: "acme/app" }); } catch (e) { return "refused: " + e.message; }
     return "published";`,
    );
    assert.match(second.result, /refused: .*cannot write outside Linguini/);
    assert.ok(second.events.some((e) => e.type === "tool.blocked" && e.data.tool === "publish"));
    const third = await script(
      "s3",
      `try { await tools.share_port({ port: 3000 }); } catch (e) { return "refused: " + e.message; }
     return "shared";`,
    );
    assert.match(third.result, /refused: .*disabled after production-data ingress/);
    assert.deepEqual(calls, ["secret_read"]);
    assert.equal((await read(store, "alice", "c")).tainted, true);
  },
);

test(
  "same script: taint from an earlier nested call refuses a later one",
  { timeout: 30_000 },
  async (t) => {
    const { calls, script } = await setup(t);
    const { result } = await script(
      "x1",
      `await tools.secret_read({});
     try { await tools.publish({ repo: "acme/app" }); } catch (e) { return "refused: " + e.message; }
     return "published";`,
    );
    assert.match(result, /refused: .*cannot write outside Linguini/);
    assert.deepEqual(calls, ["secret_read"]);
  },
);

test(
  "scripts get no Node globals, env, network, timers or models",
  { timeout: 30_000 },
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
  "off by default: without the orchestrator there is no codemode tool",
  { timeout: 30_000 },
  async (t) => {
    const { script, calls } = await setup(t, false);
    const { result } = await script("o1", `return await tools.secret_read({});`);
    assert.doesNotMatch(result, /s3cr3t/);
    assert.deepEqual(calls, []);
  },
);
