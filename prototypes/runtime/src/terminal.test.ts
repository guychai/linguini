import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import WebSocket from "ws";
import {
  TerminalManager,
  SHELL_COMMAND,
  type ExecConnector,
  type ExecHandlers,
  type TerminalStreamEvent,
} from "./terminal.ts";
import { attachTerminalStreams, originAllowed, terminalHttp } from "./terminal-api.ts";
import { ApiError } from "./store.ts";

class FakeConnector implements ExecConnector {
  opened: {
    allocId: string;
    command: string[];
    size: { cols: number; rows: number };
    h: ExecHandlers;
    writes: string[];
    sizes: number[][];
    closed: boolean;
  }[] = [];
  async open(
    allocId: string,
    command: string[],
    size: { cols: number; rows: number },
    h: ExecHandlers,
  ) {
    const e = {
      allocId,
      command,
      size,
      h,
      writes: [] as string[],
      sizes: [] as number[][],
      closed: false,
    };
    this.opened.push(e);
    return {
      write: (d: string) => {
        e.writes.push(d);
        h.onData(d); // echo
      },
      resize: (c: number, r: number) => e.sizes.push([c, r]),
      close: () => {
        e.closed = true;
      },
    };
  }
}
function setup(over: Partial<ConstructorParameters<typeof TerminalManager>[0]> = {}) {
  const connector = new FakeConnector();
  const prepared: string[] = [];
  const logs: string[] = [];
  let now = 1_000_000;
  const m = new TerminalManager({
    prepare: async (owner, id) => {
      prepared.push(`${owner}/${id}`);
      return { allocId: "a", generation: 1 };
    },
    connector,
    log: (l) => logs.push(l),
    now: () => now,
    ...over,
  });
  return { m, connector, prepared, logs, tick: (ms: number) => (now += ms), now: () => now };
}

test("open provisions the sandbox, runs a login shell in /workspace, and never passes env", async () => {
  const { m, connector, prepared } = setup();
  const snap = await m.open("o", "c1", "term-1", { cols: 100, rows: 40 });
  assert.equal(snap.status, "running");
  assert.equal(snap.cwd, "/workspace");
  assert.deepEqual(prepared, ["o/c1"]);
  assert.deepEqual(connector.opened[0]!.command, SHELL_COMMAND);
  assert.deepEqual(connector.opened[0]!.size, { cols: 100, rows: 40 });
  assert.ok(!JSON.stringify(connector.opened[0]!.command).includes("API_KEY"));
  // Re-open returns the running terminal.
  await m.open("o", "c1", "term-1");
  assert.equal(connector.opened.length, 1);
});

test("write, output events, scrollback ring buffer, resize, clear", async () => {
  const { m, connector } = setup({ historyBytes: 10 });
  await m.open("o", "c", "t");
  const events: TerminalStreamEvent[] = [];
  const off = await m.attach("o", "c", "t", (e) => events.push(e));
  m.write("o", "c", "t", "hello ");
  m.write("o", "c", "t", "world!!");
  assert.equal(events[0]!.type, "snapshot");
  assert.deepEqual(
    events.slice(1).map((e) => e.type === "output" && e.data),
    ["hello ", "world!!"],
  );
  // Reconnect: snapshot carries the (bounded) history.
  const again: TerminalStreamEvent[] = [];
  await m.attach("o", "c", "t", (e) => again.push(e));
  assert.equal(again[0]!.type === "snapshot" && again[0]!.snapshot.history, "lo world!!");
  m.resize("o", "c", "t", 90, 20);
  assert.deepEqual(connector.opened[0]!.sizes, [[90, 20]]);
  m.clear("o", "c", "t");
  assert.equal(events.at(-1)!.type, "cleared");
  off();
  assert.throws(() => m.write("o", "c", "t", "x".repeat(70_000)), /too large/);
});

test("limits per conversation and per node", async () => {
  const { m } = setup({ perConversation: 2, perNode: 3 });
  await m.open("o", "a", "1");
  await m.open("o", "a", "2");
  await assert.rejects(
    m.open("o", "a", "3"),
    (e: ApiError) => e.status === 429 && e.code === "terminal_limit_conversation",
  );
  await m.open("o", "b", "1");
  await assert.rejects(m.open("o", "c", "1"), (e: ApiError) => e.code === "terminal_limit_node");
  const shown: TerminalStreamEvent[] = [];
  await m.attach("o", "a", "9", (e) => shown.push(e), { open: true });
  assert.ok(
    shown[0]!.type === "snapshot" &&
      shown[0]!.snapshot.status === "error" &&
      /At most 2/.test(shown[0]!.snapshot.history),
  );
  m.close("o", "a", "1");
  await m.open("o", "c", "1");
  await assert.rejects(m.open("o", "a", "bad id!"), /Invalid terminal ID/);
});

test("owners are isolated", async () => {
  const { m } = setup();
  await m.open("alice", "c", "t");
  assert.throws(() => m.write("bob", "c", "t", "x"), /not found/);
  const metas: unknown[] = [];
  m.subscribeMetadata("bob", (e) => metas.push(e));
  assert.deepEqual(metas, [{ type: "snapshot", terminals: [] }]);
});

test("exit, restart on attach, close, and logs carry only counts", async () => {
  const { m, connector, logs } = setup();
  await m.open("o", "c", "t");
  m.write("o", "c", "t", "secret-command\r");
  connector.opened[0]!.h.onExit(0);
  const snapAfterExit: TerminalStreamEvent[] = [];
  await m.attach("o", "c", "t", (e) => snapAfterExit.push(e), { restartIfNotRunning: true });
  assert.equal(
    snapAfterExit[0]!.type === "snapshot" && snapAfterExit[0]!.snapshot.status,
    "starting",
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(connector.opened.length, 2);
  const restarted = await m.restart("o", "c", "t");
  assert.equal(restarted.status, "running");
  assert.equal(connector.opened[1]!.closed, true);
  m.close("o", "c");
  assert.equal(m.count(), 0);
  assert.ok(logs.some((l) => /closed .*in=\d+B out=\d+B/.test(l)));
  assert.ok(!logs.join("\n").includes("secret-command"));
});

test("prepare failure surfaces as an error status", async () => {
  const { m } = setup({
    prepare: async () => {
      throw new ApiError(503, "Sandbox not ready (failed)");
    },
  });
  await assert.rejects(m.open("o", "c", "t"), /not ready/);
  const ev: TerminalStreamEvent[] = [];
  await m.attach("o", "c", "t", (e) => ev.push(e));
  assert.equal(ev[0]!.type === "snapshot" && ev[0]!.snapshot.status, "error");
});

test("keep-alive: attached + recently active, capped", async () => {
  const { m, tick, now } = setup();
  await m.open("o", "c", "t");
  const convActivity = now();
  assert.equal(m.keepsAlive("o", "c", convActivity, 60_000, 3_600_000), false, "not attached");
  const off = await m.attach("o", "c", "t", () => undefined);
  assert.equal(m.keepsAlive("o", "c", convActivity, 60_000, 3_600_000), true);
  tick(61_000);
  assert.equal(m.keepsAlive("o", "c", convActivity, 60_000, 3_600_000), false, "inactive");
  m.write("o", "c", "t", "ls\r");
  assert.equal(m.keepsAlive("o", "c", convActivity, 60_000, 3_600_000), true);
  tick(3_600_000);
  m.write("o", "c", "t", "ls\r");
  assert.equal(m.keepsAlive("o", "c", convActivity, 60_000, 3_600_000), false, "cap");
  off();
  m.sandboxStopped("o", "c");
  const ev: TerminalStreamEvent[] = [];
  await m.attach("o", "c", "t", (e) => ev.push(e));
  assert.equal(ev[0]!.type === "snapshot" && ev[0]!.snapshot.status, "exited");
});

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
test("origin check", () => {
  assert.equal(originAllowed(req({ host: "app.x.ts.net" })), true);
  assert.equal(
    originAllowed(req({ host: "app.x.ts.net", origin: "https://app.x.ts.net" })),
    true,
  );
  assert.equal(
    originAllowed(req({ host: "app.x.ts.net", origin: "https://evil.example" })),
    false,
  );
  assert.equal(
    originAllowed(req({ host: "a", origin: "https://evil.example" }), "https://evil.example"),
    true,
  );
  assert.equal(originAllowed(req({ host: "a", origin: "null" })), false);
});

test("HTTP + WebSocket endpoints", async () => {
  const { m } = setup();
  const exists = async (_o: string, id: string) => {
    if (id !== "c") throw new ApiError(404, "Conversation not found");
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://x");
      if (!(await terminalHttp(m, exists, "o", request, response, url)))
        response.writeHead(404).end();
    } catch (e) {
      response.writeHead((e as ApiError).status ?? 500).end(String((e as Error).message));
    }
  });
  attachTerminalStreams(
    server,
    m,
    (r, token) => (token === "good" || r.headers.authorization ? "o" : undefined),
    exists,
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const post = (path: string, b: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(b) });
  try {
    const open = await post("/api/conversations/c/terminal/open", {
      terminalId: "t",
      cols: 80,
      rows: 24,
    });
    assert.equal(open.status, 200);
    assert.equal((await open.json()).status, "running");
    assert.equal(
      (await post("/api/conversations/zz/terminal/open", { terminalId: "t" })).status,
      409,
    );
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/terminal-stream?kind=attach&threadId=c&terminalId=t`,
      ["t3.bearer.good"],
      { origin: `http://127.0.0.1:${port}` },
    );
    const got: { type: string; data?: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        got.push(JSON.parse(raw.toString()));
        if (got.length === 1)
          void post("/api/conversations/c/terminal/write", { terminalId: "t", data: "pwd\r" });
        if (got.length === 2) resolve();
      });
      ws.on("error", reject);
    });
    assert.equal(got[0]!.type, "snapshot");
    assert.deepEqual(got[1], {
      type: "output",
      threadId: "c",
      terminalId: "t",
      sequence: 1,
      data: "pwd\r",
    });
    ws.close();
    // Wrong origin and missing auth are refused before the upgrade.
    for (const [protocols, origin] of [
      [["t3.bearer.good"], "https://evil.example"],
      [[], `http://127.0.0.1:${port}`],
    ] as const) {
      const bad = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminal-stream?kind=metadata`,
        [...protocols],
        { origin },
      );
      const status = await new Promise((r) =>
        bad.on("unexpected-response", (_q, res) => r(res.statusCode)).on("error", () => r("error")),
      );
      assert.ok(status === 403 || status === 401, String(status));
    }
  } finally {
    m.closeAll();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("UI-created (draft) conversation: attach waits with a message, then opens under the same UUID", async () => {
  const { m, prepared } = setup();
  const id = "a5095d83-5806-42c0-9a00-00966c6aa0d9"; // T3 draft thread id = later conversation id
  let created = false;
  const exists = async (_o: string, cid: string) => {
    if (!(created && cid === id)) throw new ApiError(404, "Conversation not found");
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://x");
      if (!(await terminalHttp(m, exists, "o", request, response, url)))
        response.writeHead(404).end();
    } catch (e) {
      response.writeHead((e as ApiError).status ?? 500).end(String((e as Error).message));
    }
  });
  attachTerminalStreams(server, m, () => "o", exists, 20);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const draftOpen = await fetch(
      `http://127.0.0.1:${port}/api/conversations/${id}/terminal/open`,
      { method: "POST", body: JSON.stringify({ terminalId: "term-1" }) },
    );
    assert.equal(draftOpen.status, 409);
    assert.match(await draftOpen.text(), /Send a message/);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/terminal-stream?kind=attach&threadId=${id}&terminalId=term-1`,
    );
    const got: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        got.push(JSON.parse(raw.toString()));
        if (got.length === 1) setTimeout(() => (created = true), 50);
        if (got.length === 2) resolve();
      });
      ws.on("error", reject);
    });
    assert.equal(got[0].snapshot.status, "starting");
    assert.match(got[0].snapshot.history, /Send a message to start this conversation first/);
    assert.equal(got[1].type, "snapshot");
    assert.equal(got[1].snapshot.status, "running");
    assert.equal(got[1].snapshot.threadId, id);
    assert.deepEqual(prepared, [`o/${id}`]);
    ws.close();
  } finally {
    m.closeAll();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
