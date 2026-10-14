import { fromPreview } from "./preview.ts";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { body } from "./gateway.ts";
import { ApiError } from "./store.ts";
import type { TerminalManager } from "./terminal.ts";

const CONV = "([a-zA-Z0-9_-]{1,100})";
/** Owner from request headers (bearer or tailnet mode); undefined = unauthenticated. */
export type OwnerResolver = (
  request: IncomingMessage,
  wsToken?: string,
) => Promise<string | undefined> | string | undefined;

/**
 * Browser requests that can change state must come from this app: the Origin's host has to be
 * the Host the request was sent to (Tailscale serve forwards it), or listed in OWN_ALLOWED_ORIGINS.
 * Requests without Origin (CLI clients) are not cross-site requests and pass.
 */
export function originAllowed(request: IncomingMessage, extra = process.env.OWN_ALLOWED_ORIGINS) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const allowed = (extra ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/** POST /api/conversations/:id/terminal/:op. Returns false when the route is not a terminal one. */
export async function terminalHttp(
  terminals: TerminalManager,
  conversationExists: (owner: string, id: string) => Promise<void>,
  owner: string,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const m = url.pathname.match(
    new RegExp(`^/api/conversations/${CONV}/terminal/(open|write|resize|clear|restart|close)$`),
  );
  if (!m) return false;
  if (request.method !== "POST") throw new ApiError(405, "Method not allowed");
  const [, id, op] = m as unknown as [string, string, string];
  await conversationExists(owner, id).catch((error) => {
    if (error instanceof ApiError && error.status === 404)
      throw new ApiError(409, DRAFT_MESSAGE, "conversation_not_started");
    throw error;
  });
  const input = await body(request);
  const terminalId = typeof input.terminalId === "string" ? input.terminalId : "default";
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  let result: unknown = {};
  switch (op) {
    case "open":
      result = await terminals.open(owner, id, terminalId, {
        cols: num(input.cols),
        rows: num(input.rows),
      });
      break;
    case "write":
      if (typeof input.data !== "string") throw new ApiError(400, "data must be a string");
      terminals.write(owner, id, terminalId, input.data);
      break;
    case "resize":
      terminals.resize(owner, id, terminalId, num(input.cols) ?? 0, num(input.rows) ?? 0);
      break;
    case "clear":
      terminals.clear(owner, id, terminalId);
      break;
    case "restart":
      result = await terminals.restart(owner, id, terminalId, {
        cols: num(input.cols),
        rows: num(input.rows),
      });
      break;
    case "close":
      terminals.close(
        owner,
        id,
        typeof input.terminalId === "string" ? input.terminalId : undefined,
      );
      break;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(result));
  return true;
}

/**
 * WebSocket streams at /api/terminal-stream:
 *   ?kind=attach|observe&threadId=&terminalId=[&cols=&rows=]  one terminal (snapshot, then events)
 *   ?kind=metadata                                              terminal list (snapshot/upsert/remove)
 *   ?kind=events                                                all terminal events of the owner
 * Auth: tailnet mode, or a bearer token as the `t3.bearer.<token>` subprotocol. Origin is checked.
 */
export function attachTerminalStreams(
  server: Server,
  terminals: TerminalManager,
  resolveOwner: OwnerResolver,
  conversationExists: (owner: string, id: string) => Promise<void>,
  draftPollMs = 2000,
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    handleProtocols: (protocols) => {
      for (const p of protocols) if (p.startsWith("t3.bearer.")) return p;
      return false;
    },
  });
  const reject = (socket: Duplex, status: number, text: string) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/preview/")) return; // the preview proxy's own listener
    if (url.pathname !== "/api/terminal-stream") return reject(socket, 404, "Not Found");
    if (!originAllowed(request) || fromPreview(request)) return reject(socket, 403, "Forbidden");
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((s) => s.trim());
    const token = protocols.find((p) => p.startsWith("t3.bearer."))?.slice("t3.bearer.".length);
    void Promise.resolve(resolveOwner(request, token)).then(
      (owner) => {
        if (!owner) return reject(socket, 401, "Unauthorized");
        wss.handleUpgrade(request, socket, head, (ws) => void serve(ws, owner, url));
      },
      (e) =>
        e instanceof ApiError && e.status === 403
          ? reject(socket, 403, "Forbidden")
          : reject(socket, 500, "Internal Server Error"),
    );
  });
  async function waitForConversation(
    ws: WebSocket,
    owner: string,
    threadId: string,
    terminalId: string,
    send: (e: unknown) => void,
  ): Promise<boolean> {
    let announced = false;
    for (;;) {
      try {
        await conversationExists(owner, threadId);
        return ws.readyState === ws.OPEN;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
      if (!announced) {
        announced = true;
        send({ type: "snapshot", snapshot: draftSnapshot(threadId, terminalId) });
      }
      await new Promise((r) => setTimeout(r, draftPollMs));
      if (ws.readyState !== ws.OPEN) return false;
    }
  }
  async function serve(ws: WebSocket, owner: string, url: URL) {
    const send = (event: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    };
    const fail = (error: unknown) => {
      send({
        type: "stream-error",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ApiError && error.code ? { code: error.code } : {}),
      });
      ws.close(1011);
    };
    let unsubscribe: (() => void) | undefined;
    ws.on("close", () => unsubscribe?.());
    const heartbeat = setInterval(() => ws.ping(), 20_000);
    ws.on("close", () => clearInterval(heartbeat));
    try {
      const kind = url.searchParams.get("kind");
      if (kind === "metadata") unsubscribe = terminals.subscribeMetadata(owner, send);
      else if (kind === "events") unsubscribe = terminals.subscribeEvents(owner, send);
      else if (kind === "attach" || kind === "observe") {
        const threadId = url.searchParams.get("threadId") ?? "";
        const terminalId = url.searchParams.get("terminalId") ?? "";
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) throw new ApiError(400, "Invalid thread ID");
        // A T3 draft thread has its final id but no backend conversation until the first
        // message. Show why, keep the stream open, and attach once the conversation exists
        // (the client does not retry a failed attach stream).
        if (!(await waitForConversation(ws, owner, threadId, terminalId, send))) return;
        const cols = Number(url.searchParams.get("cols")) || undefined;
        const rows = Number(url.searchParams.get("rows")) || undefined;
        const off = await terminals.attach(owner, threadId, terminalId, send, {
          open: kind === "attach",
          restartIfNotRunning: kind === "attach",
          cols,
          rows,
        });
        if (ws.readyState !== ws.OPEN) off();
        else unsubscribe = off;
      } else throw new ApiError(400, "Unknown stream kind");
    } catch (error) {
      fail(error);
    }
  }
  return wss;
}

export const DRAFT_MESSAGE =
  "Send a message to start this conversation first; the terminal opens then.";
export function draftSnapshot(threadId: string, terminalId: string) {
  return {
    threadId,
    terminalId,
    cwd: "/workspace",
    worktreePath: null,
    status: "starting",
    pid: null,
    history: `[terminal] ${DRAFT_MESSAGE}\r\n`,
    exitCode: null,
    exitSignal: null,
    label: "waiting",
    updatedAt: new Date().toISOString(),
    sequence: 0,
  };
}
