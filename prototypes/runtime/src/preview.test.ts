import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { createServer as createNetServer, connect as connectNet, type Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  MemoryPreviewPorts,
  PreviewActivity,
  PreviewProxy,
  PREVIEW_CSP,
  fromPreview,
  parsePreviewPath,
  previewEnvFile,
  previewToolHandler,
  rewriteSetCookie,
  validPort,
} from "./preview.ts";

/** A fake sandbox app on 127.0.0.1 (stands in for 10.x) plus Linguini's front server. */
async function rig(t: { after: (f: () => unknown) => void }) {
  const seen: Array<{
    url: string;
    headers: IncomingHttpHeaders;
    port: number;
  }> = [];
  const app = createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers, port: appPort });
    if (req.url!.endsWith("/redirect")) {
      res.writeHead(302, { location: "/login" });
      return res.end();
    }
    res.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": [
        "sid=abc; Path=/; Domain=evil.example; HttpOnly",
        "__Host-x=1; Path=/; Secure",
      ],
      "referrer-policy": "no-referrer",
    });
    res.end("<h1>app</h1>");
  });
  const wss = new WebSocketServer({ server: app });
  wss.on("headers", (headers, req) => {
    if (req.url!.endsWith("/ws-cookie"))
      headers.push(
        "Set-Cookie: wsid=1; Path=/; Domain=evil.example",
        "Set-Cookie: __Host-ws=1; Path=/; Secure",
        "Set-Cookie: linguini_session=pwned; Path=/",
      );
  });
  wss.on("connection", (ws, req) => {
    if (req.url!.endsWith("/ws-cookie")) ws.send("hello-first");
    seen.push({ url: req.url!, headers: req.headers, port: appPort });
    ws.on("message", (m) => ws.send(`echo:${m}`));
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const appPort = (app.address() as { port: number }).port;
  const ports = new MemoryPreviewPorts();
  const conversations = new Set(["alice\0c1", "alice\0c2", "bob\0c3"]);
  const activity = new PreviewActivity();
  const targets: string[] = [];
  const proxy = new PreviewProxy({
    ports,
    activity,
    targets: {
      async address(owner, id) {
        targets.push(`${owner}/${id}`);
        return "127.0.0.1";
      },
    },
    conversationExists: async (o, i) => {
      if (!conversations.has(`${o}\0${i}`)) throw new Error("404");
    },
    resolveOwner: (r) => String(r.headers["x-test-owner"] ?? "alice"),
    allowTarget: (h) => h === "127.0.0.1",
  });
  const front = createServer((req, res) => void proxy.handle(req, res));
  front.on("upgrade", (req, socket, head) => void proxy.upgrade(req, socket, head));
  front.listen(0, "127.0.0.1");
  await once(front, "listening");
  const frontPort = (front.address() as { port: number }).port;
  t.after(() => {
    wss.close();
    app.close();
    front.close();
    app.closeAllConnections();
    front.closeAllConnections();
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const r = request(
          { host: "127.0.0.1", port: frontPort, path, headers },
          (res: IncomingMessage) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
          },
        );
        r.on("error", reject);
        r.end();
      },
    );
  return { seen, ports, appPort, frontPort, get, activity, targets };
}

test("preview routing: only shared ports of an existing conversation of this owner; 404 otherwise", async (t) => {
  const r = await rig(t);
  const base = `/preview/c1/${r.appPort}`;
  assert.equal((await r.get(`${base}/`)).status, 404, "not shared yet");
  await r.ports.share("alice", "c1", { port: r.appPort });
  assert.equal((await r.get(`${base}/`)).status, 200);
  assert.equal((await r.get(base)).status, 308, "base without slash redirects");
  assert.equal((await r.get(`/preview/c2/${r.appPort}/`)).status, 404, "other conversation");
  assert.equal((await r.get(`/preview/nope/${r.appPort}/`)).status, 404, "unknown conversation");
  assert.equal(
    (await r.get(`${base}/`, { "x-test-owner": "bob" })).status,
    404,
    "another owner cannot use alice's share",
  );
  assert.equal((await r.get(`/preview/c1/${r.appPort + 1}/`)).status, 404, "unshared port");
  assert.equal((await r.get(`/preview/c1/99999/`)).status, 404);
  assert.equal((await r.get(`/preview/c1/x/`)).status, 404);
  // The path never selects the host: every forwarded request went to the conversation's sandbox.
  assert.ok(r.targets.every((x) => x === "alice/c1"));
  assert.ok(r.seen.every((s) => s.url.startsWith(`${base}/`)));
  await r.ports.unshare("alice", "c1", r.appPort);
  assert.equal((await r.get(`${base}/`)).status, 404, "unshared again");
});

test("preview headers: cookies/auth/identity stripped, preview cookies scoped, CSP sandbox, redirects kept in prefix", async (t) => {
  const r = await rig(t);
  await r.ports.share("alice", "c1", { port: r.appPort, label: "app" });
  const base = `/preview/c1/${r.appPort}`;
  const res = await r.get(`${base}/page`, {
    cookie: "linguini_session=secret; lpv_sid=abc; other=1",
    authorization: "Bearer secret-token",
    "tailscale-user-login": "ada@example.com",
    "x-forwarded-for": "1.2.3.4",
  });
  const up = r.seen.at(-1)!.headers;
  assert.equal(up.cookie, "sid=abc", "only the preview's own cookie, original name");
  assert.equal(up.authorization, undefined);
  assert.equal(up["tailscale-user-login"], undefined);
  assert.equal(up["x-forwarded-for"], undefined);
  assert.equal(up["x-forwarded-prefix"], base);
  assert.deepEqual(res.headers["set-cookie"], [`lpv_sid=abc; Path=${base}/; HttpOnly`]);
  assert.equal(res.headers["content-security-policy"], PREVIEW_CSP);
  assert.equal(res.headers["referrer-policy"], "same-origin");
  const redirect = await r.get(`${base}/redirect`);
  assert.equal(redirect.headers.location, `${base}/login`);
  await r.ports.share("alice", "c1", { port: r.appPort, cspSandbox: false });
  assert.equal((await r.get(`${base}/`)).headers["content-security-policy"], undefined, "opt-out");
  assert.equal((await r.ports.get("alice", "c1", r.appPort))?.label, "app", "label kept on update");
  // Re-sharing without an explicit opt-out restores the sandbox (no sticky opt-out).
  const again = await r.ports.share("alice", "c1", { port: r.appPort });
  assert.equal(again.cspSandbox, true);
  assert.equal(again.label, "app");
  assert.equal((await r.get(`${base}/`)).headers["content-security-policy"], PREVIEW_CSP);
});

test("share_port tool: re-share without cspSandbox resets an earlier opt-out", async () => {
  const ports = new MemoryPreviewPorts();
  const h = previewToolHandler({
    ports,
    baseUrl: (id) => `https://h/preview/${id}`,
    record: async () => {},
  });
  await h("alice", "c1", {
    tool: "share_port",
    args: { port: 3000, cspSandbox: false },
  });
  assert.equal((await ports.get("alice", "c1", 3000))?.cspSandbox, false);
  const out = await h("alice", "c1", {
    tool: "share_port",
    args: { port: 3000 },
  });
  assert.equal((await ports.get("alice", "c1", 3000))?.cspSandbox, true);
  assert.match(out.text, /CSP sandbox \(opaque origin\)/);
  await h("alice", "c1", {
    tool: "share_port",
    args: { port: 3000, cspSandbox: true },
  });
  assert.equal((await ports.get("alice", "c1", 3000))?.cspSandbox, true);
});

test("preview websocket: handshake Set-Cookie is rewritten; bytes after the head are kept", async (t) => {
  const r = await rig(t);
  await r.ports.share("alice", "c1", { port: r.appPort });
  const base = `/preview/c1/${r.appPort}/`;
  const ws = new WebSocket(`ws://127.0.0.1:${r.frontPort}${base}ws-cookie`);
  const first = once(ws, "message");
  const [res] = (await once(ws, "upgrade")) as [IncomingMessage];
  assert.deepEqual(res.headers["set-cookie"], [
    `lpv_wsid=1; Path=${base}`,
    `lpv_linguini_session=pwned; Path=${base}`,
  ]);
  assert.equal(res.headers["content-security-policy"], undefined, "no CSP on 101");
  assert.equal(String((await first)[0]), "hello-first");
  ws.send("x");
  assert.equal(String((await once(ws, "message"))[0]), "echo:x");
  ws.close();
});

async function rawUpstream(t: { after: (f: () => unknown) => void }, reply: (s: Socket) => void) {
  const srv = createNetServer((s) => s.once("data", () => reply(s)));
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  const ports = new MemoryPreviewPorts();
  await ports.share("alice", "c1", { port });
  const proxy = new PreviewProxy({
    ports,
    activity: new PreviewActivity(),
    targets: { address: async () => "127.0.0.1" },
    conversationExists: async () => {},
    resolveOwner: () => "alice",
    allowTarget: () => true,
    wsHandshakeTimeoutMs: 200,
  });
  const front = createServer((_q, res) => res.end());
  front.on("upgrade", (req, socket, head) => void proxy.upgrade(req, socket, head));
  front.listen(0, "127.0.0.1");
  await once(front, "listening");
  t.after(() => {
    srv.close();
    front.close();
    front.closeAllConnections();
  });
  const fp = (front.address() as { port: number }).port;
  return () =>
    new Promise<string>((resolve) => {
      const c = connectNet(fp, "127.0.0.1", () =>
        c.write(
          `GET /preview/c1/${port}/ws HTTP/1.1\r\nHost: 127.0.0.1:${fp}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        ),
      );
      let got = "";
      c.on("data", (d) => (got += d));
      c.on("close", () => resolve(got));
      c.on("error", () => resolve(got));
    });
}

test("preview websocket: non-101 handshake reply is sanitised (cookies, CSP) and closed", async (t) => {
  const go = await rawUpstream(t, (s) =>
    s.end(
      "HTTP/1.1 403 Forbidden\r\nSet-Cookie: sess=1; Domain=evil.example; Path=/\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nno",
    ),
  );
  const out = await go();
  assert.match(out, /^HTTP\/1\.1 403 Forbidden\r\n/);
  assert.match(out, /set-cookie: lpv_sess=1; Path=\/preview\/c1\/\d+\/\r\n/);
  assert.doesNotMatch(out, /evil\.example|keep-alive/);
  assert.match(out, /content-security-policy: sandbox allow-scripts allow-forms/);
  assert.match(out, /\r\n\r\nno$/);
});

test("preview websocket: oversized or slow handshake heads are refused", async (t) => {
  const big = await rawUpstream(t, (s) => s.write(`HTTP/1.1 101 OK\r\nX: ${"a".repeat(20_000)}`));
  assert.match(await big(), /^HTTP\/1\.1 502/);
  const slow = await rawUpstream(t, (s) => s.write("HTTP/1.1 101 Switching"));
  assert.match(await slow(), /^HTTP\/1\.1 504/);
});

test("set-cookie rewrite: path forced under the preview, domain dropped, __Host- refused", () => {
  const p = "/preview/c1/3000/";
  assert.equal(
    rewriteSetCookie("a=1; Path=/admin; Domain=x.com; Secure", p),
    `lpv_a=1; Path=${p}; Secure`,
  );
  assert.equal(rewriteSetCookie(`a=1; Path=${p}sub`, p), `lpv_a=1; Path=${p}sub`);
  assert.equal(rewriteSetCookie("__Secure-a=1", p), `lpv_a=1; Path=${p}`);
  assert.equal(rewriteSetCookie("__Host-a=1; Path=/", p), null);
  assert.equal(rewriteSetCookie("garbage", p), null);
});

test("Linguini API origin check: preview pages (opaque origin or preview referer) are recognised", () => {
  const req = (h: Record<string, string>) => ({ headers: { host: "t3.example", ...h } }) as never;
  assert.equal(fromPreview(req({ origin: "null" })), true);
  assert.equal(fromPreview(req({ referer: "https://t3.example/preview/c1/3000/x" })), true);
  assert.equal(fromPreview(req({ origin: "https://t3.example" })), false);
  assert.equal(fromPreview(req({})), false, "Linguini's UI sends no referer (no-referrer)");
  assert.equal(fromPreview(req({ referer: "https://other.example/preview/c1/3000/" })), false);
});

test("preview websocket: forwarded to the shared port only; open socket keeps the sandbox alive", async (t) => {
  const r = await rig(t);
  const url = `ws://127.0.0.1:${r.frontPort}/preview/c1/${r.appPort}/ws`;
  const refused = new WebSocket(url);
  const status = await new Promise<number>((resolve) =>
    refused.on("unexpected-response", (_q, res) => resolve(res.statusCode!)),
  );
  assert.equal(status, 404, "not shared");
  await r.ports.share("alice", "c1", { port: r.appPort });
  const cross = new WebSocket(url, { origin: "https://evil.example" });
  assert.equal(
    await new Promise<number>((resolve) =>
      cross.on("unexpected-response", (_q, res) => resolve(res.statusCode!)),
    ),
    403,
    "cross-site websocket refused",
  );
  const ws = new WebSocket(url, ["t3.bearer.secret", "app-proto"], {
    headers: { cookie: "linguini=1; lpv_k=v", authorization: "Bearer x" },
  });
  await once(ws, "open");
  ws.send("hi");
  const [msg] = await once(ws, "message");
  assert.equal(String(msg), "echo:hi");
  const up = r.seen.at(-1)!.headers;
  assert.equal(up.cookie, "k=v");
  assert.equal(up.authorization, undefined);
  assert.equal(up["sec-websocket-protocol"], "app-proto");
  assert.equal(r.activity.keepsAlive("alice", "c1", Date.now(), 0, 60_000), true, "open socket");
  ws.close();
  await once(ws, "close");
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.activity.keepsAlive("alice", "c1", Date.now(), 0, 60_000), false, "closed");
});

test("preview keepalive: recent requests or open sockets, never past the cap", () => {
  let now = 1_000_000;
  const a = new PreviewActivity(() => now);
  assert.equal(a.keepsAlive("o", "c", now, 900_000, 7_200_000), false, "never opened");
  a.touch("o", "c");
  now += 60_000;
  assert.equal(a.keepsAlive("o", "c", now - 60_000, 900_000, 7_200_000), true);
  now += 900_000;
  assert.equal(a.keepsAlive("o", "c", now - 960_000, 900_000, 7_200_000), false, "idle preview");
  a.opened("o", "c");
  now += 3_600_000;
  assert.equal(a.keepsAlive("o", "c", now - 4_000_000, 900_000, 7_200_000), true, "socket open");
  assert.equal(a.keepsAlive("o", "c", now - 7_200_000, 900_000, 7_200_000), false, "2h cap");
  assert.equal(a.keepsAlive("o", "other", now, 900_000, 7_200_000), false, "per conversation");
});

test("share_port tool: validates, records, returns URL and env file", async () => {
  const ports = new MemoryPreviewPorts();
  const notes: string[] = [];
  const h = previewToolHandler({
    ports,
    baseUrl: (id) => `https://t3.example/preview/${id}`,
    record: async (_o, _i, type) => void notes.push(type),
  });
  const out = await h("alice", "c1", {
    tool: "share_port",
    args: { port: 5173, label: "vite" },
  });
  assert.match(out.text, /https:\/\/t3\.example\/preview\/c1\/5173\//);
  assert.match(out.envFile, /PREVIEW_BASE_URL_5173='https:\/\/t3\.example\/preview\/c1\/5173\/'/);
  await assert.rejects(h("alice", "c1", { tool: "share_port", args: { port: 2375 } }));
  await assert.rejects(h("alice", "c1", { tool: "share_port", args: { port: 0 } }));
  await assert.rejects(
    h("alice", "c1", {
      tool: "share_port",
      args: { port: 3000, cspSandbox: "no" },
    }),
  );
  const off = await h("alice", "c1", {
    tool: "unshare_port",
    args: { port: 5173 },
  });
  assert.doesNotMatch(off.envFile, /5173/);
  assert.deepEqual(notes, ["preview.shared", "preview.unshared"]);
  assert.equal(validPort("8080"), 8080);
  assert.deepEqual(parsePreviewPath("/preview/c1/80/a"), {
    conversationId: "c1",
    port: 80,
    rest: "/a",
  });
  assert.equal(parsePreviewPath("/preview/../80/"), null);
  assert.equal(parsePreviewPath("/preview/c1/80x/"), null);
  assert.equal(previewEnvFile("https://h/preview/c'1", []).includes("'\\''"), true, "quoted");
});

test(
  "Postgres preview ports: re-share without cspSandbox resets an opt-out; label kept",
  { skip: process.env.TEST_DATABASE_URL ? false : "TEST_DATABASE_URL not set" },
  async () => {
    const { PostgresStore, initial } = await import("./store.ts");
    const { PostgresPreviewPorts } = await import("./preview.ts");
    const url = process.env.TEST_DATABASE_URL!;
    const store = await PostgresStore.open(url);
    const ports = await PostgresPreviewPorts.open(url);
    const id = `pv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await store.create(initial(id, "alice"));
      assert.equal((await ports.share("alice", id, { port: 3000, label: "web" })).cspSandbox, true);
      assert.equal(
        (await ports.share("alice", id, { port: 3000, cspSandbox: false })).cspSandbox,
        false,
      );
      const again = await ports.share("alice", id, { port: 3000 });
      assert.equal(again.cspSandbox, true, "opt-out does not stick");
      assert.equal(again.label, "web", "label kept");
      assert.equal((await ports.get("alice", id, 3000))?.cspSandbox, true);
      await assert.rejects(ports.share("bob", id, { port: 3000 }), /not found/i);
    } finally {
      await ports.unshare("alice", id, 3000);
      await ports.close();
      await store.close();
    }
  },
);
