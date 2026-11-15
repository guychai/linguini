// V1.1.5 Pi Durable harness: the engine drives a Durable turn with a faux model; every tool task
// passes the broker preflight; non-idempotent calls cut off by a crash become unknown outcomes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Engine } from "./engine.ts";
import {
  DurableHarness,
  DurableStore,
  FileCredentialStore,
  chooseHarness,
  durableCallId,
} from "./durable-harness.ts";
import { FixtureHarness } from "./harness.ts";
import { HostToolRegistry, type HostTool, type HostToolRun } from "./host-tools.ts";
import { DEFAULT_TOOL_POLICIES, executionId, unresolved } from "./ledger.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import {
  PostgresStore,
  SqliteStore,
  append,
  initial,
  read,
  type Conversation,
  type Store,
} from "./store.ts";

function waitFor(
  engine: Engine,
  owner: string,
  id: string,
  predicate: (c: Conversation) => boolean,
): Promise<Conversation> {
  const key = JSON.stringify([owner, id]);
  return new Promise((resolve, reject) => {
    const check = () =>
      void read(engine.store, owner, id)
        .then((c) => {
          if (predicate(c)) {
            engine.changes.off(key, check);
            resolve(c);
          }
        })
        .catch(reject);
    engine.changes.on(key, check);
    check();
  });
}

function faux() {
  const f = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(f.provider);
  return { f, models, model: { provider: "faux", modelId: f.getModel().id } };
}

const publishCalls: HostToolRun[] = [];
const publish: HostTool = {
  policy: { replay: "non-idempotent", destination: "sandbox", egress: false },
  writes: ["github"],
  destinations: (call) => [
    { kind: "github", target: String(call.args.repo), crossesBoundary: true },
  ],
  handler: async (_call, run) => {
    publishCalls.push(run);
    return { text: "published" };
  },
  description: "Publish to a repo",
  parameters: {
    type: "object",
    properties: { repo: { type: "string" } },
    required: ["repo"],
  },
};

async function fixture(t: { after(f: () => unknown): void }, kind: "sqlite" | "postgres") {
  const dir = await mkdtemp(join(tmpdir(), "durable-"));
  const store: Store =
    kind === "postgres"
      ? await PostgresStore.open(process.env.TEST_DATABASE_URL!)
      : new SqliteStore(join(dir, "state.sqlite"));
  const owner = `alice-${randomUUID()}`,
    id = randomUUID();
  await store.create(initial(id, owner));
  const broker = new SandboxBroker(store, new FixtureSandbox(), {
    hostTools: new HostToolRegistry({ publish }),
  });
  const durable = new DurableStore(join(dir, "durable"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store, owner, id, broker, durable };
}

for (const kind of ["sqlite", "postgres"] as const)
  test(
    `${kind}: engine runs Durable turns: tools through the ledger, transcript across turns`,
    { skip: kind === "postgres" && !process.env.TEST_DATABASE_URL, timeout: 30_000 },
    async (t) => {
      const { store, owner, id, broker, durable } = await fixture(t, kind);
      const { f, models, model } = faux();
      const engine = new Engine(store, (o, c, jobId, fence) =>
        DurableHarness.create({
          broker,
          owner: o,
          id: c,
          jobId,
          fence,
          store: durable,
          models,
          model,
          systemPrompt: "You are Linguini's test agent.",
        }),
      );
      try {
        f.setResponses([
          fauxAssistantMessage(
            [fauxText("Writing. "), fauxToolCall("write", { path: "note.txt", content: "hi" })],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Wrote note.txt."),
        ]);
        await engine.command(owner, id, { commandId: "one", kind: "prompt", text: "first ask" });
        let c = await waitFor(engine, owner, id, (c) => c.jobs[0]?.status === "done");
        await engine.idle(owner, id);
        c = await read(store, owner, id);
        assert.equal(c.harness, "durable");
        assert.equal(c.piEntries, undefined);
        const events = c.events.filter((e) => e.data.jobId === "one");
        const text = events
          .filter((e) => e.type === "assistant.delta")
          .map((e) => e.data.text)
          .join("");
        assert.equal(text, "Writing. \n\nWrote note.txt.");
        const started = events.find((e) => e.type === "tool.started")!;
        assert.equal(started.data.tool, "write");
        assert.ok(events.some((e) => e.type === "tool.output" && e.data.tool === "write"));
        // The broker call ID is Durable's (restart-stable), so the ledger entry is found again.
        const entry = c.ledger![executionId(owner, id, durableCallId(String(started.data.callId)))];
        assert.equal(entry?.status, "observed");
        assert.equal(entry?.tool, "write");

        let seen: string[] = [];
        let offered: string[] = [];
        f.setResponses([
          (context) => {
            seen = context.messages.flatMap((m) =>
              m.role === "user" && typeof m.content === "string" ? [m.content] : [],
            );
            // Tools are declared in the transcript's system messages (added minus removed).
            offered = context.messages
              .flatMap((m: any) =>
                m.role === "system"
                  ? (m.toolsAdded ?? []).map((t: { name: string }) => t.name)
                  : [],
              )
              .sort();
            return fauxAssistantMessage("Second answer.");
          },
        ]);
        await engine.command(owner, id, { commandId: "two", kind: "prompt", text: "second ask" });
        await waitFor(engine, owner, id, (c) => c.jobs[1]?.status === "done");
        await engine.idle(owner, id);
        assert.deepEqual(seen, ["first ask", "second ask"]);
        // Only Linguini's tools: no Durable coding tools, no code mode, no models.* tools.
        assert.deepEqual(offered, [
          "bash",
          "edit",
          "find",
          "grep",
          "html_preview",
          "html_render",
          "ls",
          "publish",
          "read",
          "share_port",
          "unshare_port",
          "write",
        ]);
      } finally {
        await engine.stop();
      }
      if (process.env.DURABLE_PG_URL) {
        // SPIKE: the transcript is the Postgres log; deletion empties it.
        const pool = new (await import("pg")).default.Pool({ connectionString: process.env.DURABLE_PG_URL });
        const n = async () =>
          (await pool.query("SELECT count(*)::int n FROM prototype_durable_log WHERE log_key=$1", [durable.path(owner, id)])).rows[0].n;
        assert.ok((await n()) > 0);
        await durable.remove(owner, id);
        assert.equal(await n(), 0);
        await pool.end();
      } else {
        await access(durable.path(owner, id));
        await durable.remove(owner, id);
        await assert.rejects(access(durable.path(owner, id)));
      }
    },
  );

test("beforeTool: refused calls never reach a tool body (taint, sensitive boundary, unknown outcome)", async (t) => {
  const { store, owner, id, broker, durable } = await fixture(t, "sqlite");
  const { f, models, model } = faux();
  const turn = async (jobId: string, responses: Parameters<typeof f.setResponses>[0]) => {
    f.setResponses(responses);
    const h = await DurableHarness.create({
      broker,
      owner,
      id,
      jobId,
      store: durable,
      models,
      model,
      systemPrompt: "test",
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
    return events;
  };
  const results: string[] = [];
  const recordResult = (context: { messages: readonly any[] }) => {
    const last = context.messages.at(-1);
    results.push(
      last?.role === "toolResult"
        ? last.content.map((b: { text?: string }) => b.text ?? "").join("")
        : "",
    );
    return fauxAssistantMessage("ok");
  };

  // Sensitive (tainted) conversation: share_port is egress-capable, publish crosses the boundary.
  await store.mutate(owner, id, (c) => {
    c.tainted = true;
    append(c, "taint.changed", { tainted: true, reason: "test" });
  });
  let events = await turn("taint", [
    fauxAssistantMessage([fauxToolCall("share_port", { port: 3000 })], { stopReason: "toolUse" }),
    recordResult,
  ]);
  assert.match(results.at(-1)!, /disabled after production-data ingress/);
  assert.ok(events.some((e) => e.type === "tool.blocked" && e.data.tool === "share_port"));
  assert.ok(!events.some((e) => e.type === "tool.started"));
  events = await turn("boundary", [
    fauxAssistantMessage([fauxToolCall("publish", { repo: "acme/app" })], {
      stopReason: "toolUse",
    }),
    recordResult,
  ]);
  assert.match(results.at(-1)!, /cannot write outside Linguini/);
  assert.equal(publishCalls.length, 0);

  // An unknown outcome blocks every tool, even a safe read.
  await store.mutate(owner, id, (c) => {
    c.ledger = {
      xblock: {
        execId: "xblock",
        callId: "earlier",
        tool: "write",
        args: {},
        argsDigest: "",
        replay: "non-idempotent",
        destination: "sandbox",
        epoch: 0,
        status: "unknown",
        policyVersion: broker.policyVersion,
        createdAt: new Date().toISOString(),
      } as never,
    };
  });
  events = await turn("blocked", [
    fauxAssistantMessage([fauxToolCall("read", { path: "note.txt" })], { stopReason: "toolUse" }),
    recordResult,
  ]);
  assert.match(results.at(-1)!, /Blocked: the outcome of write call earlier/);
  assert.ok(!events.some((e) => e.type === "tool.started"));
  assert.equal(Object.keys((await read(store, owner, id)).ledger ?? {}).length, 1);
});

test("tools: only declared tools are offered, only safe reads are replay-safe", async (t) => {
  const { broker } = await fixture(t, "sqlite");
  const names = Object.keys(broker.policies).sort();
  assert.ok(names.includes("publish"));
  const safe = names.filter((n) => broker.policies[n]!.replay === "safe-read").sort();
  assert.deepEqual(safe, ["find", "grep", "html_preview", "ls", "read"]);
  assert.equal(DEFAULT_TOOL_POLICIES.bash!.replay, "non-idempotent");
});

test(
  "crash mid-call: the cut-off non-idempotent call becomes an unknown outcome and blocks",
  { timeout: 60_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "durable-crash-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // The child starts a turn whose publish call hangs, and exits mid-call (a crash).
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "durable-crash.fixture.ts"), dir],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0, out);
    assert.match(out, /crashing/);
    const store = new SqliteStore(join(dir, "state.sqlite"));
    t.after(() => store.close());
    let c = await read(store, "alice", "c");
    const intent = Object.values(c.ledger ?? {}).find((e) => e.tool === "publish");
    assert.equal(intent?.status, "intent");
    // Reopen without the engine's lease reconciliation: the Durable side alone must not re-run the
    // call, and must turn it into an unknown outcome.
    const handled: HostToolRun[] = [];
    const broker = new SandboxBroker(store, new FixtureSandbox(), {
      hostTools: new HostToolRegistry({
        publish: { ...publish, handler: async (_c, run) => (handled.push(run), { text: "again" }) },
      }),
    });
    const { f, models, model } = faux();
    f.setResponses([fauxAssistantMessage("after")]);
    const h = await DurableHarness.create({
      broker,
      owner: "alice",
      id: "c",
      jobId: "next",
      store: new DurableStore(join(dir, "durable")),
      models,
      model,
      systemPrompt: "test",
    });
    h.dispose();
    c = await read(store, "alice", "c");
    assert.equal(handled.length, 0);
    assert.deepEqual(
      unresolved(c).map((e) => e.tool),
      ["publish"],
    );
    assert.ok(c.events.some((e) => e.type === "tool.outcome_unknown"));
  },
);

test("FixtureHarness still runs under the same engine", async (t) => {
  const { store, owner, id, broker } = await fixture(t, "sqlite");
  const engine = new Engine(store, async (o, c, job) => new FixtureHarness(broker, o, c, job));
  try {
    await engine.command(owner, id, { commandId: "f", kind: "prompt", text: "hello" });
    await waitFor(engine, owner, id, (c) => c.jobs[0]?.status === "done");
    await engine.idle(owner, id);
    assert.equal((await read(store, owner, id)).harness, undefined);
  } finally {
    await engine.stop();
  }
});

test(
  "cancel mid-tool, steer, and model errors surface like the Pi harness",
  { timeout: 30_000 },
  async (t) => {
    const { store, owner, id, durable } = await fixture(t, "sqlite");
    let entered!: () => void;
    const inTool = new Promise<void>((r) => (entered = r));
    const slow: HostTool = {
      policy: { replay: "idempotent-write", destination: "sandbox", egress: false },
      writes: [],
      destinations: () => [],
      handler: (_call, run) =>
        new Promise((_, reject) => {
          entered();
          run.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
            once: true,
          });
        }),
      description: "Wait",
      parameters: { type: "object", properties: {} },
    };
    const broker = new SandboxBroker(store, new FixtureSandbox(), {
      hostTools: new HostToolRegistry({ slow }),
    });
    const { f, models, model } = faux();
    const engine = new Engine(store, (o, c, jobId, fence) =>
      DurableHarness.create({
        broker,
        owner: o,
        id: c,
        jobId,
        fence,
        store: durable,
        models,
        model,
        systemPrompt: "test",
        retry: { enabled: false },
      }),
    );
    try {
      f.setResponses([
        fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("never"),
      ]);
      await engine.command(owner, id, { commandId: "a", kind: "prompt", text: "wait" });
      await inTool;
      await engine.command(owner, id, { commandId: "stop", kind: "cancel", jobId: "a" });
      await waitFor(engine, owner, id, (c) => c.jobs[0]?.status === "cancelled");
      await engine.idle(owner, id);

      // A model error ends the turn with the reason, not a blank reply.
      f.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota exceeded" }),
      ]);
      await engine.command(owner, id, { commandId: "b", kind: "prompt", text: "hi" });
      let c = await waitFor(engine, owner, id, (c) =>
        ["done", "failed"].includes(c.jobs[1]?.status ?? ""),
      );
      await engine.idle(owner, id);
      c = await read(store, owner, id);
      const err = c.events.find((e) => e.type === "assistant.error" && e.data.jobId === "b");
      assert.ok(
        err,
        JSON.stringify(c.events.filter((e) => e.data.jobId === "b").map((e) => e.type)),
      );
      assert.match(String(err.data.message), /quota exceeded/);

      // Steering lands in the running turn.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let steered = false;
      f.setResponses([
        async () => {
          release();
          await new Promise((r) => setTimeout(r, 300));
          return fauxAssistantMessage([fauxToolCall("read", { path: "x" })], {
            stopReason: "toolUse",
          });
        },
        (context) => {
          steered = context.messages.some(
            (m) => m.role === "user" && typeof m.content === "string" && m.content === "also this",
          );
          return fauxAssistantMessage("done");
        },
      ]);
      await engine.command(owner, id, { commandId: "c", kind: "prompt", text: "go" });
      await held;
      await engine.command(owner, id, {
        commandId: "s",
        kind: "steer",
        text: "also this",
        targetJobId: "c",
      });
      await waitFor(engine, owner, id, (c) => c.jobs.find((j) => j.id === "c")?.status === "done");
      await engine.idle(owner, id);
      assert.ok(steered);
    } finally {
      await engine.stop();
    }
  },
);

test("cutover: new threads start on Durable; Pi threads keep piEntries; Durable threads stay", () => {
  const c = initial("c", "alice");
  c.jobs.push({ id: "j1", text: "x", status: "running" } as never);
  assert.equal(chooseHarness(c, "j1", "durable"), "durable");
  assert.equal(chooseHarness(c, "j1", "pi"), "pi");
  assert.equal(chooseHarness(c, "j1", "fixture"), "fixture");
  const old = structuredClone(c);
  old.jobs.unshift({ id: "j0", text: "y", status: "done" } as never);
  assert.equal(chooseHarness(old, "j1", "durable"), "pi");
  const imported = structuredClone(c);
  imported.piEntries = [{ type: "session" } as never];
  assert.equal(chooseHarness(imported, "j1", "durable"), "pi");
  const durableThread = structuredClone(old);
  durableThread.harness = "durable";
  assert.equal(chooseHarness(durableThread, "j1", "pi"), "durable");
});

test("credentials: auth.json read and atomic 0600 writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "durable-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi-config", "auth.json");
  const creds = new FileCredentialStore(path);
  assert.equal(await creds.read("anthropic"), undefined);
  await creds.modify("anthropic", async () => ({ type: "api_key", key: "test-not-a-key" }));
  assert.deepEqual(await creds.read("anthropic"), { type: "api_key", key: "test-not-a-key" });
  assert.deepEqual(await creds.list(), [{ providerId: "anthropic", type: "api_key" }]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await creds.delete("anthropic");
  assert.equal(await creds.read("anthropic"), undefined);
});
