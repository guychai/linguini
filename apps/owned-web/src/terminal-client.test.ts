import test from "node:test";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import {
  terminalCommand,
  terminalStream,
  terminalStreamUrl,
  type TerminalDeps,
} from "./terminal-client.ts";

function deps(over: Partial<TerminalDeps> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sockets: FakeSocket[] = [];
  // Promise-based waits (no fixed sleeps): the stream opens and closes its socket on Effect's
  // scheduler, so "10 ms later" is not guaranteed under load.
  const waiters: Array<() => void> = [];
  const notify = () => waiters.splice(0).forEach((w) => w());
  const until = async (ready: () => boolean) => {
    while (!ready()) await new Promise<void>((r) => waiters.push(r));
  };
  /** Resolves with the n-th socket (0-based) once the client has constructed it. */
  const socket = async (n: number) => (await until(() => sockets.length > n), sockets[n]!);
  /** Resolves once the client has closed socket n. */
  const closed = (n: number) => until(() => sockets[n]?.closed === true);
  class FakeSocket {
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
    closed = false;
    constructor(
      public url: string,
      public protocols: string[],
    ) {
      sockets.push(this);
      notify();
    }
    close() {
      this.closed = true;
      notify();
    }
  }
  const d: TerminalDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    }) as typeof fetch,
    token: () => "",
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    location: { protocol: "https:", host: "app.example.ts.net" },
    ...over,
  };
  return { d, calls, sockets, socket, closed };
}

test("commands POST only the safe fields; cwd/env/provider are not forwarded", async () => {
  const { d, calls } = deps();
  const snap = await terminalCommand(
    "terminal.open",
    {
      threadId: "c1",
      terminalId: "term-1",
      cwd: "/home/x",
      env: { ANTHROPIC_API_KEY: "x" },
      providerInstanceId: "pi",
      cols: 80,
      rows: 24,
    },
    d,
  );
  assert.deepEqual(snap, { status: "running" });
  assert.equal(calls[0]!.url, "/api/conversations/c1/terminal/open");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    terminalId: "term-1",
    cols: 80,
    rows: 24,
  });
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, undefined);
  assert.equal(
    await terminalCommand(
      "terminal.write",
      { threadId: "c1", terminalId: "term-1", data: "ls\r" },
      d,
    ),
    undefined,
  );
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { terminalId: "term-1", data: "ls\r" });
  await terminalCommand("terminal.close", { threadId: "c1" }, d);
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), {});
  await assert.rejects(
    terminalCommand(
      "terminal.open",
      { threadId: "c", terminalId: "t", cwd: "/workspace", worktreePath: "/wt" },
      d,
    ),
    /Worktree/,
  );
});

test("command errors carry the backend message", async () => {
  const { d } = deps({
    fetch: (async () =>
      new Response(JSON.stringify({ error: "At most 4 terminals per conversation" }), {
        status: 429,
      })) as unknown as typeof fetch,
    token: () => "tok",
  });
  await assert.rejects(
    terminalCommand("terminal.open", { threadId: "c", terminalId: "t5", cwd: "/workspace" }, d),
    /At most 4/,
  );
});

test("stream URLs", () => {
  const loc = { protocol: "https:", host: "h" };
  assert.equal(
    terminalStreamUrl(
      "terminal.attach",
      { threadId: "c", terminalId: "t", cols: 80, rows: 24 },
      loc,
    ),
    "wss://h/api/terminal-stream?kind=attach&threadId=c&terminalId=t&cols=80&rows=24",
  );
  assert.equal(
    terminalStreamUrl("subscribeTerminalMetadata", {}, { protocol: "http:", host: "h:1" }),
    "ws://h:1/api/terminal-stream?kind=metadata",
  );
  assert.throws(() => terminalStreamUrl("terminal.other", {}, loc));
});

test("attach stream yields socket events, fails on stream-error, closes on release", async () => {
  const { d, socket, closed } = deps({ token: () => "tok" });
  const fiber = Effect.runFork(
    Stream.runCollect(
      Stream.take(terminalStream("terminal.attach", { threadId: "c", terminalId: "t" }, d), 2),
    ),
  );
  const first = await socket(0);
  assert.deepEqual(first.protocols, ["t3.bearer.tok"]);
  first.onmessage!({
    data: JSON.stringify({ type: "snapshot", snapshot: { history: "x" } }),
  });
  first.onmessage!({ data: JSON.stringify({ type: "output", data: "y" }) });
  const out = await Effect.runPromise(Fiber.join(fiber));
  assert.deepEqual(
    [...out].map((e: any) => e.type),
    ["snapshot", "output"],
  );
  await closed(0); // released when the stream ends (the test times out otherwise)
  assert.equal(first.closed, true);

  const failing = Effect.runPromise(
    Stream.runCollect(terminalStream("subscribeTerminalMetadata", {}, d)),
  );
  (await socket(1)).onmessage!({
    data: JSON.stringify({ type: "stream-error", message: "Conversation not found" }),
  });
  await assert.rejects(failing, /Conversation not found/);
});
