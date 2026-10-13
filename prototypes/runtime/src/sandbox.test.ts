import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SqliteStore, initial, read } from "./store.ts";
import {
  SandboxBroker,
  FixtureSandbox,
  assertPublicationAllowed,
  type SandboxProvider,
} from "./sandbox.ts";
import { gateway } from "./gateway.ts";
import { issueCapability } from "./capability.ts";
import { sandboxTools } from "./pi-tools.ts";

test("owner isolation and lazy allocation survive duplicate and conflicting commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  try {
    await store.create(initial("a", "alice"));
    await store.create(initial("b", "bob"));
    const provider = new FixtureSandbox(),
      broker = new SandboxBroker(store, provider);
    assert.equal((await read(store, "alice", "a")).sandbox, null);
    await assert.rejects(
      broker.execute("bob", "a", { id: "bad", tool: "read", args: { path: "secret" } }),
      /not found/,
    );
    assert.equal(provider.allocations, 0);
    const call = {
      id: "write-1",
      tool: "write" as const,
      args: { path: "a.txt", content: "private" },
    };
    const results = await Promise.all([
      broker.execute("alice", "a", call),
      broker.execute("alice", "a", call),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(provider.allocations, 1);
    await assert.rejects(
      broker.execute("alice", "a", { ...call, args: { path: "a.txt", content: "changed" } }),
      /different payload/,
    );
    await assert.rejects(
      broker.execute("bob", "b", { id: "read-1", tool: "read", args: { path: "a.txt" } }),
      /not found/,
    );
    assert.equal(Object.keys((await read(store, "bob", "b")).files).length, 0);
    assert.equal(
      (await read(store, "alice", "a")).events.filter((e) => e.type === "tool.result").length,
      1,
    );
    await assert.rejects(
      broker.execute("alice", "a", {
        id: "escape",
        tool: "read",
        args: { path: "../../etc/passwd" },
      }),
      /Invalid sandbox path/,
    );
    await assert.rejects(
      broker.execute("alice", "a", {
        id: "shell",
        tool: "bash",
        args: { command: "cat /etc/passwd" },
      }),
      /no host execution/,
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true });
  }
});

test("durable production-data taint blocks PR, publication and shell bypass after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-taint-")),
    db = join(dir, "state.sqlite");
  let store = new SqliteStore(db);
  try {
    await store.create(initial("a", "alice"));
    const broker = new SandboxBroker(store, new FixtureSandbox());
    await broker.execute("alice", "a", {
      id: "prod",
      tool: "bash",
      args: { command: "fixture:production-read" },
    });
    await store.close();
    store = new SqliteStore(db);
    const restarted = new SandboxBroker(store, new FixtureSandbox());
    const c = await read(store, "alice", "a");
    assert.equal(c.tainted, true);
    assert.throws(() => assertPublicationAllowed(c), /permanently blocks/);
    await assert.rejects(
      restarted.execute("alice", "a", {
        id: "publish",
        tool: "bash",
        args: { command: "gh pr create" },
      }),
      /disabled after production-data ingress/,
    );
    await store.mutate("alice", "a", (c) => {
      c.files = {};
    });
    assert.equal((await read(store, "alice", "a")).tainted, true);
  } finally {
    await store.close();
    await rm(dir, { recursive: true });
  }
});

test("ambiguous remote outcomes are not replayed and taint commits before dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-crash-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  try {
    await store.create(initial("a", "alice"));
    let calls = 0;
    const provider: SandboxProvider = {
      kind: "remote",
      allocate: async () => "remote-a",
      execute: async () => {
        calls++;
        throw new Error("worker crashed");
      },
    };
    const call = {
      id: "external-side-effect",
      tool: "write" as const,
      args: { path: "x", content: "x" },
    };
    await assert.rejects(new SandboxBroker(store, provider).execute("alice", "a", call), /crashed/);
    assert.equal((await read(store, "alice", "a")).tainted, true);
    await assert.rejects(
      new SandboxBroker(store, provider).execute("alice", "a", call),
      /outcome unknown/,
    );
    assert.equal(calls, 1);
  } finally {
    await store.close();
    await rm(dir, { recursive: true });
  }
});

test("Pi registered tools reach the gateway; capabilities cannot change owners; reconnect replays receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-http-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  const key = "test-only-capability-signing-key-000000000";
  const broker = new SandboxBroker(store, new FixtureSandbox());
  const server = gateway(broker, key);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const capability = issueCapability(key, "alice", "a");
  const request = async (route: string, input: unknown, token = capability) =>
    fetch(`${url}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  try {
    const tools = sandboxTools(async (call) => {
      const response = await request("/tools", call);
      assert.equal(response.status, 200);
      return await response.json();
    });
    const write = tools.find((t) => t.name === "write")!;
    await write.execute(
      "pi-write",
      { path: "hello.txt", content: "Hello sandbox" },
      undefined,
      undefined,
      {} as never,
    );
    const reader = tools.find((t) => t.name === "read")!;
    const result = await reader.execute(
      "pi-read",
      { path: "hello.txt" },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal(result.content[0]?.type, "text");
    assert.equal((result.content[0] as { text: string }).text, "Hello sandbox");
    const retry = await request("/tools", {
      id: "pi-write",
      tool: "write",
      args: { path: "hello.txt", content: "Hello sandbox" },
    });
    assert.equal(retry.status, 200);
    assert.equal((await request("/tools", {}, `${capability}tamper`)).status, 401);
    assert.equal(
      (
        await request(
          "/tools",
          { id: "steal", tool: "read", args: { path: "hello.txt" } },
          issueCapability(key, "bob", "b"),
        )
      ).status,
      404,
    );
    await request("/tools", {
      id: "prod",
      tool: "bash",
      args: { command: "fixture:production-read" },
    });
    for (const route of ["/actions/create-pr", "/actions/publish"])
      assert.equal((await request(route, {})).status, 403);
    assert.equal((await request("/terminal", {})).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(dir, { recursive: true });
  }
});

test("fixture grep, find and ls answer from the conversation's sandbox files only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-tools-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  try {
    await store.create(initial("t", "alice"));
    const broker = new SandboxBroker(store, new FixtureSandbox());
    const run = (id: string, tool: string, args: Record<string, unknown>) =>
      broker.execute("alice", "t", { id, tool, args });
    await run("w1", "write", { path: "src/a.ts", content: "alpha\nNeedle one" });
    await run("w2", "write", { path: "src/deep/b.spec.ts", content: "needle two" });
    await run("w3", "write", { path: "notes.md", content: "needle (literal)" });
    assert.equal((await run("l1", "ls", {})).text, "notes.md\nsrc/");
    assert.equal((await run("l2", "ls", { path: "src" })).text, "a.ts\ndeep/");
    await assert.rejects(run("l3", "ls", { path: "nope" }), /not found/);
    assert.equal(
      (await run("f1", "find", { pattern: "*.ts" })).text,
      "src/a.ts\nsrc/deep/b.spec.ts",
    );
    assert.equal(
      (await run("f2", "find", { pattern: "src/**/*.spec.ts" })).text,
      "src/deep/b.spec.ts",
    );
    assert.equal(
      (await run("f3", "find", { pattern: "*.ts", path: "src/deep" })).text,
      "b.spec.ts",
    );
    assert.equal(
      (await run("g1", "grep", { pattern: "needle", ignoreCase: true, glob: "*.ts" })).text,
      "src/a.ts:2:Needle one\nsrc/deep/b.spec.ts:1:needle two",
    );
    assert.equal(
      (await run("g2", "grep", { pattern: "(literal)", literal: true })).text,
      "notes.md:1:needle (literal)",
    );
    assert.equal((await run("g3", "grep", { pattern: "zzz" })).text, "No matches found");
    await assert.rejects(
      run("g4", "grep", { pattern: "x", path: "../etc" }),
      /Invalid sandbox path|outside/,
    );
    await assert.rejects(run("g5", "grep", { pattern: "(" }), /Invalid regular expression/);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
