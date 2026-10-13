/**
 * Preview ports: https://<host>/preview/<conversationId>/<port>/... forwards HTTP and WebSocket
 * traffic into that conversation's own sandbox, only to ports the conversation explicitly shared.
 *
 * - Target: always the conversation's sandbox address (server-derived, validated 10.x) and a
 *   shared port from the database. The URL only selects among those; nothing else is reachable.
 * - Request hygiene: Linguini cookies, Authorization, Tailscale identity and forwarding headers
 *   are dropped. Only cookies the preview itself set (stored under an `lpv_` prefix, path-scoped
 *   to the preview) go back to it.
 * - Response hygiene: `Content-Security-Policy: sandbox allow-scripts allow-forms` (opaque
 *   origin, so preview pages cannot use Linguini's origin) unless the latest share explicitly
 *   opted out (re-sharing without cspSandbox: false restores the sandbox);
 *   Set-Cookie is renamed, path-scoped to the preview, and loses Domain.
 * - Linguini's own API refuses requests that come from preview pages (`fromPreview`).
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, isIPv4 } from "node:net";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import { ApiError } from "./store.ts";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface PreviewPort {
  port: number;
  label: string;
  cspSandbox: boolean;
  createdAt: string;
}
export interface PreviewPortStore {
  list(owner: string, conversationId: string): Promise<PreviewPort[]>;
  get(owner: string, conversationId: string, port: number): Promise<PreviewPort | null>;
  share(
    owner: string,
    conversationId: string,
    p: { port: number; label?: string; cspSandbox?: boolean },
  ): Promise<PreviewPort>;
  unshare(owner: string, conversationId: string, port: number): Promise<boolean>;
}

/** Ports never shareable: the inner Docker daemon's TCP API. */
const BLOCKED_PORTS = new Set([2375, 2376]);
export function validPort(v: unknown): number {
  const n = typeof v === "string" && /^\d{1,5}$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535)
    throw new ApiError(400, "port must be an integer 1-65535");
  if (BLOCKED_PORTS.has(n)) throw new ApiError(400, `port ${n} cannot be shared`);
  return n;
}
const cleanLabel = (v: unknown) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) : "";

export class MemoryPreviewPorts implements PreviewPortStore {
  private rows = new Map<string, PreviewPort>();
  private k = (o: string, c: string, p: number) => `${o}\0${c}\0${p}`;
  async list(owner: string, id: string) {
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${owner}\0${id}\0`))
      .map(([, v]) => structuredClone(v))
      .sort((a, b) => a.port - b.port);
  }
  async get(owner: string, id: string, port: number) {
    return structuredClone(this.rows.get(this.k(owner, id, port)) ?? null);
  }
  async share(
    owner: string,
    id: string,
    p: { port: number; label?: string; cspSandbox?: boolean },
  ) {
    const port = validPort(p.port);
    const prev = this.rows.get(this.k(owner, id, port));
    const row: PreviewPort = {
      port,
      label: p.label === undefined ? (prev?.label ?? "") : cleanLabel(p.label),
      // Opting out is per share: a share without an explicit false resets to the safe default.
      cspSandbox: p.cspSandbox !== false,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
    };
    this.rows.set(this.k(owner, id, port), row);
    return structuredClone(row);
  }
  async unshare(owner: string, id: string, port: number) {
    return this.rows.delete(this.k(owner, id, port));
  }
}

/**
 * Postgres table prototype_preview_ports. Created only when missing (checked with to_regclass
 * first, so a normal startup takes no lock); rows go with their conversation (ON DELETE CASCADE).
 */
export class PostgresPreviewPorts implements PreviewPortStore {
  private constructor(private readonly pool: Pool) {}
  static async open(url: string) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    const exists = await pool.query("SELECT to_regclass('prototype_preview_ports') AS t");
    if (!exists.rows[0]?.t) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(731942063)");
        await client.query(`CREATE TABLE IF NOT EXISTS prototype_preview_ports (
          conversation_id TEXT NOT NULL REFERENCES prototype_conversations(id) ON DELETE CASCADE,
          owner TEXT NOT NULL,
          port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
          label TEXT NOT NULL DEFAULT '',
          csp_sandbox BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (conversation_id, port))`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return new PostgresPreviewPorts(pool);
  }
  private row = (r: Record<string, unknown>): PreviewPort => ({
    port: Number(r.port),
    label: String(r.label ?? ""),
    cspSandbox: r.csp_sandbox !== false,
    createdAt: new Date(r.created_at as string).toISOString(),
  });
  async list(owner: string, id: string) {
    const r = await this.pool.query(
      "SELECT * FROM prototype_preview_ports WHERE owner = $1 AND conversation_id = $2 ORDER BY port",
      [owner, id],
    );
    return r.rows.map(this.row);
  }
  async get(owner: string, id: string, port: number) {
    const r = await this.pool.query(
      "SELECT * FROM prototype_preview_ports WHERE owner = $1 AND conversation_id = $2 AND port = $3",
      [owner, id, port],
    );
    return r.rows[0] ? this.row(r.rows[0]) : null;
  }
  async share(
    owner: string,
    id: string,
    p: { port: number; label?: string; cspSandbox?: boolean },
  ) {
    const port = validPort(p.port);
    // Only for a conversation of this owner (the FK alone would accept another owner's id).
    const r = await this.pool.query(
      `INSERT INTO prototype_preview_ports (conversation_id, owner, port, label, csp_sandbox)
         SELECT c.id, c.owner, $3, COALESCE($4, ''), $5
         FROM prototype_conversations c WHERE c.id = $2 AND c.owner = $1
       ON CONFLICT (conversation_id, port) DO UPDATE SET
         label = COALESCE($4, prototype_preview_ports.label),
         csp_sandbox = $5
       RETURNING *`,
      [owner, id, port, p.label === undefined ? null : cleanLabel(p.label), p.cspSandbox !== false],
    );
    if (!r.rows[0]) throw new ApiError(404, "Conversation not found");
    return this.row(r.rows[0]);
  }
  async unshare(owner: string, id: string, port: number) {
    const r = await this.pool.query(
      "DELETE FROM prototype_preview_ports WHERE owner = $1 AND conversation_id = $2 AND port = $3",
      [owner, id, port],
    );
    return (r.rowCount ?? 0) > 0;
  }
  close() {
    return this.pool.end();
  }
}

// ---- keepalive ----
/** Recent preview requests or an open preview WebSocket keep the sandbox (up to a cap). */
export class PreviewActivity {
  private last = new Map<string, number>();
  private sockets = new Map<string, number>();
  constructor(private readonly now = () => Date.now()) {}
  private key = (o: string, c: string) => `${o}\0${c}`;
  touch(owner: string, id: string) {
    this.last.set(this.key(owner, id), this.now());
  }
  opened(owner: string, id: string) {
    const k = this.key(owner, id);
    this.sockets.set(k, (this.sockets.get(k) ?? 0) + 1);
    this.touch(owner, id);
  }
  closed(owner: string, id: string) {
    const k = this.key(owner, id);
    const n = (this.sockets.get(k) ?? 1) - 1;
    if (n > 0) this.sockets.set(k, n);
    else this.sockets.delete(k);
    this.touch(owner, id);
  }
  /** Deleted conversation: drop its keep-alive state. */
  forget(owner: string, id: string) {
    this.last.delete(this.key(owner, id));
    this.sockets.delete(this.key(owner, id));
  }
  keepsAlive(
    owner: string,
    id: string,
    conversationActivityMs: number,
    recentMs: number,
    capMs: number,
  ) {
    const k = this.key(owner, id);
    const now = this.now();
    const active = (this.sockets.get(k) ?? 0) > 0 || now - (this.last.get(k) ?? 0) < recentMs;
    return active && now - conversationActivityMs < capMs;
  }
}

// ---- request classification ----
const PREVIEW_PATH = /^\/preview\/([A-Za-z0-9_-]{1,100})\/(\d{1,5})(\/.*)?$/;
export function parsePreviewPath(pathname: string) {
  const m = PREVIEW_PATH.exec(pathname);
  if (!m) return null;
  return { conversationId: m[1]!, port: Number(m[2]), rest: m[3] };
}
/** True when a request was made by a preview page (never Linguini's own UI). */
export function fromPreview(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (origin === "null") return true;
  const referer = request.headers.referer;
  if (referer) {
    try {
      const u = new URL(referer);
      if (u.host === request.headers.host && u.pathname.startsWith("/preview/")) return true;
    } catch {}
  }
  return false;
}

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);
const DROP_REQUEST =
  /^(cookie|authorization|proxy-authorization|forwarded|x-forwarded-.*|x-real-ip|tailscale-.*|x-tailscale-.*)$/i;
export const COOKIE_PREFIX = "lpv_";
/**
 * Preview grant cookie. A sandboxed preview page (CSP sandbox: opaque origin) loads its
 * subresources cross-site, so the SameSite=Lax session cookie is not sent with them. The first
 * top-level load (which does carry the session) sets this grant: an HMAC over owner,
 * conversation, port and expiry, HttpOnly, Path-scoped to that one preview. It is never
 * forwarded to the sandbox (only lpv_ cookies are), and the sandbox cannot set it (its cookies
 * are always renamed to lpv_*).
 */
export const GRANT_COOKIE = "lpg";
const GRANT_TTL_S = 12 * 3600;
const grantMac = (key: Buffer, owner: string, id: string, port: number, exp: number) =>
  createHmac("sha256", key).update(`${owner}\n${id}\n${port}\n${exp}`).digest("base64url");
export function issueGrant(
  key: Buffer,
  owner: string,
  id: string,
  port: number,
  secure: boolean,
  now = Date.now(),
) {
  const exp = Math.floor(now / 1000) + GRANT_TTL_S;
  const value = `${Buffer.from(owner).toString("base64url")}.${exp}.${grantMac(key, owner, id, port, exp)}`;
  return [
    `${GRANT_COOKIE}=${value}`,
    `Path=/preview/${id}/${port}/`,
    `Max-Age=${GRANT_TTL_S}`,
    "HttpOnly",
    secure ? "Secure; SameSite=None" : "SameSite=Lax",
  ].join("; ");
}
export function verifyGrant(
  key: Buffer,
  cookieHeader: string | undefined,
  id: string,
  port: number,
  now = Date.now(),
): string | undefined {
  for (const part of String(cookieHeader ?? "").split(";")) {
    const [name, ...v] = part.trim().split("=");
    if (name !== GRANT_COOKIE) continue;
    const [o, e, mac] = v.join("=").split(".");
    if (!o || !e || !mac || !/^\d+$/.test(e) || Number(e) * 1000 < now) continue;
    const owner = Buffer.from(o, "base64url").toString();
    const want = Buffer.from(grantMac(key, owner, id, port, Number(e)));
    const got = Buffer.from(mac);
    if (want.length === got.length && timingSafeEqual(want, got)) return owner;
  }
  return undefined;
}

/** Headers sent to the sandbox app. */
export function forwardRequestHeaders(
  headers: IncomingMessage["headers"],
  prefix: string,
  upgrade = false,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const listed = String(headers.connection ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const name = k.toLowerCase();
    if (DROP_REQUEST.test(name)) continue;
    if (!upgrade && (HOP.has(name) || listed.includes(name))) continue;
    if (name === "sec-websocket-protocol") {
      const kept = String(v)
        .split(",")
        .map((s) => s.trim())
        .filter((p) => p && !p.startsWith("t3.bearer."));
      if (kept.length) out[name] = kept.join(", ");
      continue;
    }
    out[name] = v;
  }
  // Only the preview's own cookies, under their original names.
  const cookies = String(headers.cookie ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(COOKIE_PREFIX))
    .map((s) => s.slice(COOKIE_PREFIX.length));
  if (cookies.length) out.cookie = cookies.join("; ");
  out["x-forwarded-host"] = String(headers.host ?? "");
  out["x-forwarded-proto"] = "https";
  out["x-forwarded-prefix"] = prefix.replace(/\/$/, "");
  return out;
}

/** Set-Cookie from the app: renamed, path-scoped to the preview, no Domain. */
export function rewriteSetCookie(value: string, prefix: string): string | null {
  const parts = value.split(";").map((s) => s.trim());
  const first = parts.shift() ?? "";
  const eq = first.indexOf("=");
  if (eq < 1) return null;
  const name = first.slice(0, eq).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || name.startsWith("__Host-")) return null;
  const attrs: string[] = [];
  let path: string | undefined;
  for (const a of parts) {
    const key = a.split("=")[0]!.trim().toLowerCase();
    if (key === "domain") continue;
    if (key === "path") {
      path = a.slice(a.indexOf("=") + 1).trim();
      continue;
    }
    if (a) attrs.push(a);
  }
  const scoped = path && path.startsWith(prefix) ? path : prefix;
  const cleanName = name.startsWith("__Secure-") ? name.slice(9) : name;
  return [`${COOKIE_PREFIX}${cleanName}=${first.slice(eq + 1)}`, `Path=${scoped}`, ...attrs].join(
    "; ",
  );
}

export const PREVIEW_CSP = "sandbox allow-scripts allow-forms";
/** Headers sent back to the browser. */
export function previewResponseHeaders(
  headers: IncomingMessage["headers"],
  prefix: string,
  cspSandbox: boolean,
) {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const name = k.toLowerCase();
    if (HOP.has(name) || name === "set-cookie" || name === "referrer-policy") continue;
    if (
      name === "location" &&
      typeof v === "string" &&
      v.startsWith("/") &&
      !v.startsWith("//") &&
      !v.startsWith(prefix.replace(/\/$/, ""))
    )
      out[name] = prefix.replace(/\/$/, "") + v;
    else out[name] = v;
  }
  const cookies = (headers["set-cookie"] ?? [])
    .map((c) => rewriteSetCookie(c, prefix))
    .filter((c): c is string => c !== null);
  if (cookies.length) out["set-cookie"] = cookies;
  // Keep the preview path in Referer so Linguini's API can recognise preview-originated calls.
  out["referrer-policy"] = "same-origin";
  if (cspSandbox) {
    const existing = out["content-security-policy"];
    out["content-security-policy"] = [
      ...(existing === undefined ? [] : Array.isArray(existing) ? existing : [existing]),
      PREVIEW_CSP,
    ];
  }
  return out;
}

/** Max size of an upstream WebSocket handshake response head. */
export const WS_HEAD_LIMIT = 16 * 1024;
/** Parses an HTTP/1.x response head (without the final blank line); null if malformed. */
export function parseResponseHead(text: string) {
  const [statusLine, ...rest] = text.split("\r\n");
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine ?? "");
  if (!m) return null;
  const headers: Record<string, string | string[]> = {};
  for (const line of rest) {
    const i = line.indexOf(":");
    if (i < 1) return null;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (name === "set-cookie") ((headers[name] ??= []) as string[]).push(value);
    else if (headers[name] === undefined) headers[name] = value;
    else headers[name] = `${headers[name]}, ${value}`;
  }
  return {
    status: Number(m[1]),
    reason: m[2] ?? "",
    headers: headers as IncomingMessage["headers"],
  };
}

// ---- the proxy ----
export interface PreviewTargets {
  /** The conversation's sandbox address, starting the sandbox if needed. */
  address(owner: string, conversationId: string): Promise<string>;
}
export interface PreviewProxyOptions {
  ports: PreviewPortStore;
  targets: PreviewTargets;
  activity: PreviewActivity;
  conversationExists(owner: string, id: string): Promise<void>;
  resolveOwner(request: IncomingMessage): Promise<string | undefined> | string | undefined;
  timeoutMs?: number;
  /** How long the sandbox app may take to answer a WebSocket handshake. */
  wsHandshakeTimeoutMs?: number;
  /** Signs preview grants (see GRANT_COOKIE); absent: the session itself must reach every request. */
  grantKey?: Buffer;
  /** Test seam; production accepts only sandbox network addresses (10.x). */
  allowTarget?: (host: string) => boolean;
}
const notFound = (res: ServerResponse) => {
  res.writeHead(404, {
    "content-type": "text/plain",
    "cache-control": "no-store",
  });
  res.end("Preview not found (no such conversation, or the port is not shared)\n");
};
export class PreviewProxy {
  constructor(private readonly o: PreviewProxyOptions) {}
  /** The shared port record and sandbox address, or null (respond 404). */
  private async resolve(request: IncomingMessage, pathname: string) {
    const p = parsePreviewPath(pathname);
    if (!p) return null;
    if (p.port < 1 || p.port > 65535) return null;
    let owner = await this.o.resolveOwner(request);
    const viaSession = !!owner;
    if (!owner && this.o.grantKey)
      owner = verifyGrant(this.o.grantKey, request.headers.cookie, p.conversationId, p.port);
    if (!owner) throw new ApiError(401, "Authentication required");
    try {
      await this.o.conversationExists(owner, p.conversationId);
    } catch {
      return null;
    }
    const shared = await this.o.ports.get(owner, p.conversationId, p.port);
    if (!shared) return null;
    const prefix = `/preview/${p.conversationId}/${p.port}/`;
    const grant =
      viaSession && this.o.grantKey
        ? issueGrant(
            this.o.grantKey,
            owner,
            p.conversationId,
            p.port,
            request.headers["x-forwarded-proto"] === "https" ||
              String(request.headers.host ?? "").endsWith(".ts.net"),
          )
        : undefined;
    return { ...p, owner, shared, prefix, grant };
  }
  private async target(owner: string, id: string) {
    const host = await this.o.targets.address(owner, id);
    // Defence in depth: only a sandbox network address, never anything the URL could name.
    const ok = this.o.allowTarget ?? ((h: string) => h.startsWith("10."));
    if (!isIPv4(host) || !ok(host)) throw new Error("invalid sandbox address");
    return host;
  }
  async handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://localhost");
    let r;
    try {
      r = await this.resolve(request, url.pathname);
    } catch (error) {
      response.writeHead(error instanceof ApiError ? error.status : 500, {
        "content-type": "text/plain",
      });
      return response.end(error instanceof ApiError ? `${error.message}\n` : "Internal error\n");
    }
    if (!r) return notFound(response);
    if (r.rest === undefined) {
      response.writeHead(308, { location: `${r.prefix}${url.search}` });
      return response.end();
    }
    this.o.activity.touch(r.owner, r.conversationId);
    let host: string;
    try {
      host = await this.target(r.owner, r.conversationId);
    } catch (error) {
      response.writeHead(503, {
        "content-type": "text/plain",
        "cache-control": "no-store",
      });
      return response.end(
        `Sandbox unavailable: ${error instanceof Error ? error.message : error}\n`,
      );
    }
    const upstream = httpRequest({
      host,
      port: r.port,
      method: request.method,
      path: request.url,
      headers: forwardRequestHeaders(request.headers, r.prefix),
      timeout: this.o.timeoutMs ?? 120_000,
    });
    upstream.on("response", (res) => {
      const out = previewResponseHeaders(res.headers, r.prefix, r.shared.cspSandbox);
      if (r.grant) out["set-cookie"] = [...((out["set-cookie"] as string[]) ?? []), r.grant];
      response.writeHead(res.statusCode ?? 502, out);
      res.pipe(response);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", (error) => {
      if (response.headersSent) return response.destroy();
      response.writeHead(502, {
        "content-type": "text/plain",
        "cache-control": "no-store",
      });
      response.end(
        `Nothing answered on port ${r.port} in the sandbox (${(error as NodeJS.ErrnoException).code ?? error.message}). ` +
          "The sandbox may have restarted: ask the agent to start the server again (listening on 0.0.0.0).\n",
      );
    });
    request.pipe(upstream);
  }
  /**
   * WebSocket (any Upgrade) for /preview/...: same checks; the upstream handshake response is
   * parsed and sanitised (Set-Cookie rewritten, hop headers dropped) before the raw TCP splice.
   */
  async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: number, text: string) =>
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    // Cross-site WebSocket hijacking: only the preview itself (opaque or same host) may connect.
    const origin = request.headers.origin;
    if (origin && origin !== "null") {
      try {
        if (new URL(origin).host !== request.headers.host) return reject(403, "Forbidden");
      } catch {
        return reject(403, "Forbidden");
      }
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    let r;
    try {
      r = await this.resolve(request, url.pathname);
    } catch {
      return reject(401, "Unauthorized");
    }
    if (!r || r.rest === undefined) return reject(404, "Not Found");
    let host: string;
    try {
      host = await this.target(r.owner, r.conversationId);
    } catch {
      return reject(503, "Service Unavailable");
    }
    const headers = forwardRequestHeaders(request.headers, r.prefix, true);
    const reqLines = [`${request.method} ${request.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers))
      for (const one of Array.isArray(v) ? v : [v]) reqLines.push(`${k}: ${one}`);
    const upstream = connect({ host, port: r.port });
    const { owner, conversationId, prefix } = r;
    const cspSandbox = r.shared.cspSandbox;
    this.o.activity.opened(owner, conversationId);
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      clearTimeout(headTimer);
      this.o.activity.closed(owner, conversationId);
      upstream.destroy();
      socket.destroy();
    };
    let headSent = false;
    let buffered = Buffer.alloc(0);
    const headTimer = setTimeout(() => {
      if (!closed) reject(504, "Gateway Timeout");
      done();
    }, this.o.wsHandshakeTimeoutMs ?? 30_000);
    // Read the upstream handshake response head, sanitise it like any HTTP response, then splice.
    const onHead = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > WS_HEAD_LIMIT) {
          clearTimeout(headTimer);
          reject(502, "Bad Gateway");
          done();
        }
        return;
      }
      clearTimeout(headTimer);
      upstream.off("data", onHead);
      const parsed = parseResponseHead(buffered.subarray(0, end).toString("latin1"));
      const rest = buffered.subarray(end + 4);
      if (!parsed) {
        reject(502, "Bad Gateway");
        return done();
      }
      const switching = parsed.status === 101;
      const out = previewResponseHeaders(parsed.headers, prefix, cspSandbox && !switching);
      if (switching) {
        // The upgrade itself needs these; previewResponseHeaders drops hop-by-hop headers.
        out.connection = "Upgrade";
        out.upgrade = String(parsed.headers.upgrade ?? "websocket");
      } else out.connection = "close";
      const lines = [`HTTP/1.1 ${parsed.status} ${parsed.reason}`.trimEnd()];
      for (const [k, v] of Object.entries(out))
        for (const one of Array.isArray(v) ? v : [v])
          if (!/[\r\n]/.test(one)) lines.push(`${k}: ${one}`);
      headSent = true;
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (!switching) {
        // Forward whatever body came with it, then close.
        socket.end(rest);
        upstream.destroy();
        return;
      }
      if (rest.length) socket.write(rest);
      upstream.pipe(socket);
      socket.pipe(upstream);
    };
    upstream.on("connect", () => {
      upstream.write(`${reqLines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.on("data", onHead);
    });
    // Each frame keeps the conversation's preview activity fresh.
    socket.on("data", () => this.o.activity.touch(owner, conversationId));
    upstream.on("error", () => {
      if (!headSent && !closed) reject(502, "Bad Gateway");
      done();
    });
    socket.on("error", done);
    upstream.on("close", done);
    socket.on("close", done);
  }
}

// ---- sandbox side ----
/** /etc/linguini/preview.env: sourced by bash (BASH_ENV), login shells and preview-url. */
export function previewEnvFile(baseUrl: string, ports: number[]) {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    "# Written by Linguini: public preview URLs for this conversation's shared ports.",
    `export PREVIEW_BASE_URL=${q(baseUrl)}`,
    ...ports.map((p) => `export PREVIEW_BASE_URL_${p}=${q(`${baseUrl}/${p}/`)}`),
    "",
  ].join("\n");
}
export const PREVIEW_URL_HELPER = `#!/bin/sh
# preview-url <port>: the public base URL (with trailing slash) for a shared port.
case "\${1:-}" in ''|*[!0-9]*) echo "usage: preview-url <port>" >&2; exit 64;; esac
. /etc/linguini/preview.env 2>/dev/null || true
[ -n "\${PREVIEW_BASE_URL:-}" ] || { echo "previews are not configured" >&2; exit 69; }
echo "\${PREVIEW_BASE_URL}/$1/"
`;
/** Installs the env file, the profile hook and the helper (stdin = JSON {env, helper}). */
export const PREVIEW_INSTALL_SCRIPT = `set -eu
mkdir -p /etc/linguini /etc/profile.d /usr/local/bin
cat > /etc/linguini/preview.env.tmp
mv /etc/linguini/preview.env.tmp /etc/linguini/preview.env
echo '[ -r /etc/linguini/preview.env ] && . /etc/linguini/preview.env' > /etc/profile.d/zz-linguini-preview.sh
cat > /usr/local/bin/preview-url <<'HELPER'
${PREVIEW_URL_HELPER}HELPER
chmod 0755 /usr/local/bin/preview-url
grep -q linguini/preview.env /root/.bashrc 2>/dev/null || echo '[ -r /etc/linguini/preview.env ] && . /etc/linguini/preview.env' >> /root/.bashrc
`;

// ---- the share_port / unshare_port tools ----
export function previewToolHandler(o: {
  ports: PreviewPortStore;
  /** https://<host>/preview/<conversationId> (no trailing slash). */
  baseUrl(conversationId: string): string;
  /** Journal note so the UI refreshes its preview chip. */
  record(
    owner: string,
    conversationId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void>;
}) {
  return async (
    owner: string,
    id: string,
    call: { tool: string; args: Record<string, unknown> },
  ) => {
    const port = validPort(call.args.port);
    const base = o.baseUrl(id);
    let text: string;
    if (call.tool === "share_port") {
      if (call.args.cspSandbox !== undefined && typeof call.args.cspSandbox !== "boolean")
        throw new ApiError(400, "cspSandbox must be a boolean");
      const p = await o.ports.share(owner, id, {
        port,
        ...(call.args.label === undefined ? {} : { label: String(call.args.label) }),
        // Omitted cspSandbox means the safe default (true), even if an earlier share opted out.
        ...(call.args.cspSandbox === false ? { cspSandbox: false } : {}),
      });
      await o.record(owner, id, "preview.shared", {
        port,
        label: p.label,
        cspSandbox: p.cspSandbox,
      });
      text = [
        `Shared port ${port}. Preview URL: ${base}/${port}/`,
        `The app must listen on 0.0.0.0:${port} and serve under the base path /preview/${id}/${port}/ (also in $PREVIEW_BASE_URL_${port} and \`preview-url ${port}\`).`,
        p.cspSandbox
          ? "Pages are served with CSP sandbox (opaque origin): cookies/localStorage are unavailable to scripts."
          : "CSP sandbox is OFF for this preview (same origin as Linguini).",
        "The user sees a Preview chip in the conversation.",
      ].join("\n");
    } else {
      const removed = await o.ports.unshare(owner, id, port);
      if (removed) await o.record(owner, id, "preview.unshared", { port });
      text = removed ? `Port ${port} is no longer shared.` : `Port ${port} was not shared.`;
    }
    const ports = (await o.ports.list(owner, id)).map((p) => p.port);
    return { text, envFile: previewEnvFile(base, ports) };
  };
}
