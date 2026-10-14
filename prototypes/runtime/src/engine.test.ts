import { TOOL_DESCRIPTIONS } from "./pi-tools.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  PostgresStore,
  SqliteStore,
  initial,
  read,
  type Conversation,
  type Store,
} from "./store.ts";
import { Engine } from "./engine.ts";
import { FixtureHarness, PiHarness } from "./harness.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import { api } from "./api.ts";

async function waitFor(
  engine: Engine,
  owner: string,
  id: string,
  predicate: (c: Conversation) => boolean,
): Promise<Conversation> {
  const key = JSON.stringify([owner, id]);
  return new Promise((resolve, reject) => {
    const check = () => {
      void read(engine.store, owner, id)
        .then((c) => {
          if (predicate(c)) {
            engine.changes.off(key, check);
            resolve(c);
          }
        })
        .catch((e) => {
          engine.changes.off(key, check);
          reject(e);
        });
    };
    engine.changes.on(key, check);
    check();
  });
}
for (const kind of ["sqlite", "postgres"] as const) {
  test(
    `${kind}: owned command lifecycle, isolation, duplicate cancellation, steering, queue and lazy sandbox`,
    { skip: kind === "postgres" && !process.env.TEST_DATABASE_URL, timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "owned-engine-")),
        suffix = randomUUID();
      const store: Store =
        kind === "postgres"
          ? await PostgresStore.open(process.env.TEST_DATABASE_URL!)
          : new SqliteStore(join(dir, "state.sqlite"));
      const owner = `alice-${suffix}`,
        bob = `bob-${suffix}`,
        id = suffix;
      const provider = new FixtureSandbox(),
        broker = new SandboxBroker(store, provider);
      const engine = new Engine(store, async (o, c, job) => new FixtureHarness(broker, o, c, job));
      try {
        await store.create(initial(id, owner));
        const command = { commandId: "hello", kind: "prompt" as const, text: "hello" };
        await Promise.all([engine.command(owner, id, command), engine.command(owner, id, command)]);
        await waitFor(engine, owner, id, (c) => c.jobs[0]?.status === "done");
        await engine.idle(owner, id);
        assert.equal((await read(store, owner, id)).jobs.length, 1);
        assert.equal(provider.allocations, 0);
        await assert.rejects(
          engine.command(owner, id, { ...command, text: "different" }),
          /different payload/,
        );
        await assert.rejects(engine.command(bob, id, command), /not found/);
        await engine.command(owner, id, {
          commandId: "waiting",
          kind: "prompt",
          text: "/fixture wait",
        });
        await waitFor(engine, owner, id, (c) =>
          c.events.some((e) => e.type === "fixture.waiting" && e.data.jobId === "waiting"),
        );
        await engine.command(owner, id, {
          commandId: "queued",
          kind: "queue",
          text: "/fixture write note.txt durable",
        });
        assert.equal(
          (await read(store, owner, id)).jobs.find((j) => j.id === "queued")?.status,
          "queued",
        );
        await engine.command(owner, id, {
          commandId: "queue-discard",
          kind: "queue",
          text: "/fixture write discarded.txt no",
        });
        await engine.command(owner, id, {
          commandId: "queue-edit",
          kind: "queue_edit",
          jobId: "queued",
          text: "/fixture write note.txt edited",
        });
        await engine.command(owner, id, {
          commandId: "queue-reorder",
          kind: "queue_reorder",
          jobId: "queued",
          beforeJobId: "queue-discard",
        });
        await engine.command(owner, id, {
          commandId: "queue-cancel",
          kind: "queue_cancel",
          jobId: "queue-discard",
        });
        await engine.command(owner, id, { commandId: "steer", kind: "steer", text: "continue" });
        await waitFor(
          engine,
          owner,
          id,
          (c) => c.jobs.find((j) => j.id === "queued")?.status === "done",
        );
        await engine.idle(owner, id);
        let c = await read(store, owner, id);
        assert.ok(c.events.some((e) => e.type === "steering.accepted"));
        assert.equal(c.files["note.txt"], "edited");
        assert.equal(c.files["discarded.txt"], undefined);
        assert.equal(provider.allocations, 1);
        await engine.command(owner, id, {
          commandId: "cancel-me",
          kind: "prompt",
          text: "/fixture wait",
        });
        await waitFor(engine, owner, id, (c) =>
          c.events.some((e) => e.type === "fixture.waiting" && e.data.jobId === "cancel-me"),
        );
        await engine.command(owner, id, { commandId: "cancel-once", kind: "cancel" });
        await engine.idle(owner, id);
        await engine.command(owner, id, {
          commandId: "new-wait",
          kind: "prompt",
          text: "/fixture wait",
        });
        await waitFor(engine, owner, id, (c) =>
          c.events.some((e) => e.type === "fixture.waiting" && e.data.jobId === "new-wait"),
        );
        await engine.command(owner, id, { commandId: "cancel-once", kind: "cancel" });
        c = await read(store, owner, id);
        assert.equal(c.jobs.find((j) => j.id === "new-wait")?.status, "running");
        await engine.command(owner, id, {
          commandId: "steer-new",
          kind: "steer",
          text: "continue",
        });
        await waitFor(
          engine,
          owner,
          id,
          (c) => c.jobs.find((j) => j.id === "new-wait")?.status === "done",
        );
        await engine.idle(owner, id);
        assert.equal(
          (await read(store, owner, id)).jobs.find((j) => j.id === "cancel-me")?.status,
          "cancelled",
        );
      } finally {
        await engine.stop();
        await store.close();
        await rm(dir, { recursive: true });
      }
    },
  );

  test(
    `${kind}: worker restart preserves queue, history and irreversible production taint`,
    { skip: kind === "postgres" && !process.env.TEST_DATABASE_URL, timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "owned-restart-")),
        id = randomUUID(),
        owner = `restart-${id}`;
      const open = () =>
        kind === "postgres"
          ? PostgresStore.open(process.env.TEST_DATABASE_URL!)
          : Promise.resolve(new SqliteStore(join(dir, "state.sqlite")));
      let store = await open(),
        provider = new FixtureSandbox();
      const makeEngine = () => {
        const broker = new SandboxBroker(store, provider);
        return new Engine(store, async (o, c, job) => new FixtureHarness(broker, o, c, job));
      };
      let engine = makeEngine();
      try {
        await store.create(initial(id, owner));
        await engine.command(owner, id, {
          commandId: "production",
          kind: "prompt",
          text: "/fixture bash fixture:production-read",
        });
        await waitFor(engine, owner, id, (c) => c.jobs[0]?.status === "done");
        await engine.idle(owner, id);
        await engine.command(owner, id, {
          commandId: "interrupted",
          kind: "prompt",
          text: "/fixture wait",
        });
        await waitFor(engine, owner, id, (c) => c.events.some((e) => e.type === "fixture.waiting"));
        await engine.command(owner, id, {
          commandId: "survives",
          kind: "queue",
          text: "/fixture write recovered.txt queue survived",
        });
        await engine.stop();
        await store.close();
        store = await open();
        provider = new FixtureSandbox();
        engine = makeEngine();
        await engine.recover(owner);
        await waitFor(
          engine,
          owner,
          id,
          (c) => c.jobs.find((j) => j.id === "survives")?.status === "done",
        );
        await engine.idle(owner, id);
        const c = await read(store, owner, id);
        assert.equal(c.tainted, true);
        assert.equal(c.files["recovered.txt"], "queue survived");
        assert.equal(c.jobs.find((j) => j.id === "interrupted")?.status, "interrupted");
        assert.equal(provider.allocations, 0);
        assert.ok(
          c.events.some((e) => e.type === "assistant.completed" && e.data.jobId === "production"),
        );
        for (const kind of ["create_pr", "publish"] as const)
          await assert.rejects(
            engine.command(owner, id, { commandId: `export-${kind}`, kind }),
            /Production-data taint/,
          );
        await assert.rejects(
          new SandboxBroker(store, provider).execute(owner, id, {
            id: "shell-bypass",
            tool: "bash",
            args: { command: "gh pr create" },
          }),
          /disabled after production-data ingress/,
        );
      } finally {
        await engine.stop();
        await store.close();
        await rm(dir, { recursive: true });
      }
    },
  );
}

test(
  "owned HTTP adapter authenticates owners and replays SSE after disconnect without gaps",
  { timeout: 20_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "owned-http-")),
      store = new SqliteStore(join(dir, "state.sqlite"));
    const provider = new FixtureSandbox(),
      broker = new SandboxBroker(store, provider);
    const engine = new Engine(store, async (o, c, job) => new FixtureHarness(broker, o, c, job));
    const alice = "test-only-alice-token-0000000000000000",
      bob = "test-only-bob-token-000000000000000000";
    const { server, closeStreams } = api(engine, { [alice]: "alice", [bob]: "bob" });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const req = (path: string, token = alice, input?: unknown, signal?: AbortSignal) =>
      fetch(`${origin}${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        signal,
      });
    const command = (kind: string, commandId: string, text?: string) =>
      req("/api/conversations/one/commands", alice, { kind, commandId, text });
    try {
      assert.equal((await req("/api/conversations", alice, { id: "one" })).status, 201);
      assert.equal((await req("/api/conversations/one", bob)).status, 404);
      assert.equal((await req("/api/conversations/one/events", bob)).status, 404);
      assert.equal((await req("/api/conversations", "invalid")).status, 401);
      const controller = new AbortController(),
        stream = await req(
          "/api/conversations/one/events?after=0",
          alice,
          undefined,
          controller.signal,
        );
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      assert.equal(
        (await command("prompt", "write", "/fixture write hello.txt streamed result")).status,
        202,
      );
      await waitFor(engine, "alice", "one", (c) => c.jobs[0]?.status === "done");
      await engine.idle("alice", "one");
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes('"type":"run.completed"')) {
        const { value } = await reader.read();
        received += decoder.decode(value);
      }
      const ids = [...received.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(ids.every((id, index) => index === 0 || id > ids[index - 1]!));
      assert.match(received, /streamed result/);
      controller.abort();
      const cursor = ids[Math.floor(ids.length / 2)]!,
        reconnectController = new AbortController();
      const reconnect = await req(
        `/api/conversations/one/events?after=${cursor}`,
        alice,
        undefined,
        reconnectController.signal,
      );
      const buffer = decoder.decode((await reconnect.body!.getReader().read()).value);
      const replay = [...buffer.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      assert.ok(replay.every((id) => id > cursor));
      assert.deepEqual(
        replay,
        ids.filter((id) => id > cursor),
      );
      reconnectController.abort();
      assert.equal(
        (await command("prompt", "prod", "/fixture bash fixture:production-read")).status,
        202,
      );
      await waitFor(
        engine,
        "alice",
        "one",
        (c) => c.jobs.find((j) => j.id === "prod")?.status === "done",
      );
      for (const kind of ["create_pr", "publish"])
        assert.equal((await command(kind, kind)).status, 403);
      assert.equal((await req("/api/terminals")).status, 404);
      assert.equal((await req("/api/conversations/one/events?after=999999")).status, 409);
    } finally {
      closeStreams();
      await engine.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
      await rm(dir, { recursive: true });
    }
  },
);

test(
  "real Pi SDK registers only sandbox tools and routes a registered write through the broker",
  { timeout: 20_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sdk-")),
      store = new SqliteStore(join(dir, "state.sqlite"));
    let pi: PiHarness | undefined;
    try {
      await store.create(initial("sdk", "alice"));
      const provider = new FixtureSandbox(),
        broker = new SandboxBroker(store, provider);
      pi = await PiHarness.create(broker, "alice", "sdk", join(dir, "host-control"));
      const session = (pi as unknown as { session: AgentSession }).session;
      // Pi's built-ins are disabled; grep/find/ls are the sandbox versions with the same names.
      const sandboxed = [
        "bash",
        "edit",
        "find",
        "grep",
        "html_preview",
        "html_render",
        "ls",
        "read",
        "share_port",
        "unshare_port",
        "write",
      ];
      assert.deepEqual(session.getActiveToolNames().sort(), sandboxed);
      assert.deepEqual(session.getCallableToolNames().sort(), sandboxed);
      for (const name of sandboxed)
        assert.equal(
          session.getToolDefinition(name)!.description,
          TOOL_DESCRIPTIONS[name as keyof typeof TOOL_DESCRIPTIONS],
        );
      const write = session.getToolDefinition("write")!;
      await write.execute(
        "sdk-write",
        { path: "sdk.txt", content: "SDK boundary checked" },
        undefined,
        undefined,
        {} as never,
      );
      assert.equal((await read(store, "alice", "sdk")).files["sdk.txt"], "SDK boundary checked");
      assert.equal(provider.allocations, 1);
    } finally {
      pi?.dispose();
      await store.close();
      await rm(dir, { recursive: true });
    }
  },
);
