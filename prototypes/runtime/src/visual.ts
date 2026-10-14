/**
 * Visual replies, backend side: the `html_preview` / `html_render` tool handlers, the
 * per-conversation render store, and signed page URLs.
 *
 * - Storage: one row per published page in prototype_html_renders (owner, conversation, page,
 *   bytes), ON DELETE CASCADE with the conversation, counted against the owner's quota.
 * - URLs: `/render/<attachmentId>.html?c=<conversation>&e=<expiry>&s=<sig>`, HMAC over id, owner,
 *   conversation and expiry. Serving re-reads the row, checks the signature against the row's own
 *   owner and conversation, that the conversation still exists, and that a signed-in requester
 *   is that owner. Served with RENDER_CSP (sandbox: opaque origin, no network), nosniff, no
 *   referrer; never Service-Worker-Allowed or Clear-Site-Data.
 * - Limits: page size (html-render.ts), per-user and global render concurrency, per-user quota.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  HTML_RENDER_COLUMN_WIDTH,
  preparePage,
  RENDER_CSP,
  RENDER_RESULT_MESSAGE,
  validFrameHeight,
  validHtml,
  validTitle,
  validWidth,
  type SandboxImageReader,
} from "./html-render.ts";
import {
  HTML_RENDER_MEASURE_FRAGMENT_DARK,
  HTML_RENDER_MEASURE_FRAGMENT_LIGHT,
  HTML_RENDER_MEASURE_WIDTHS,
} from "./html-render-vendor.ts";
import { Gate, type Renderer } from "./render-worker.ts";
import type { ToolCall, ToolResult } from "./sandbox.ts";
import { ApiError } from "./store.ts";

export interface StoredRender {
  id: string;
  owner: string;
  conversationId: string;
  title: string;
  height: number;
  heights?: Array<[number, number]>;
  html: string;
  bytes: number;
  createdAt: string;
}
export interface RenderStore {
  /** Inserts (or returns the existing row for `id`); 404 unless the owner owns the conversation. */
  put(row: Omit<StoredRender, "bytes" | "createdAt">, quotaBytes: number): Promise<StoredRender>;
  get(id: string): Promise<StoredRender | null>;
  usage(owner: string): Promise<number>;
}

export const RENDER_ID = /^[a-f0-9]{32}-html$/;

export class MemoryRenderStore implements RenderStore {
  readonly rows = new Map<string, StoredRender>();
  constructor(private readonly conversationOwner: (id: string) => Promise<string | null>) {}
  async put(row: Omit<StoredRender, "bytes" | "createdAt">, quotaBytes: number) {
    const existing = this.rows.get(row.id);
    if (existing) return structuredClone(existing);
    if ((await this.conversationOwner(row.conversationId)) !== row.owner)
      throw new ApiError(404, "Conversation not found");
    const bytes = Buffer.byteLength(row.html);
    if ((await this.usage(row.owner)) + bytes > quotaBytes) throw quotaError(quotaBytes);
    const stored = { ...row, bytes, createdAt: new Date().toISOString() };
    this.rows.set(row.id, stored);
    return structuredClone(stored);
  }
  async get(id: string) {
    return structuredClone(this.rows.get(id) ?? null);
  }
  async usage(owner: string) {
    return [...this.rows.values()]
      .filter((r) => r.owner === owner)
      .reduce((n, r) => n + r.bytes, 0);
  }
  /** Conversation deletion (Postgres cascades instead). */
  forget(conversationId: string) {
    for (const [k, r] of this.rows) if (r.conversationId === conversationId) this.rows.delete(k);
  }
}
const quotaError = (quota: number) =>
  new ApiError(
    413,
    `Your stored visual replies would exceed ${Math.round(quota / 1024 / 1024)} MiB. Delete old conversations to free space.`,
    "render_quota",
  );

/**
 * Postgres table prototype_html_renders, created only when missing (to_regclass first, so a
 * normal startup takes no lock). Rows cascade with their conversation.
 */
export class PostgresRenderStore implements RenderStore {
  private constructor(private readonly pool: Pool) {}
  static async open(url: string) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 4 });
    const exists = await pool.query("SELECT to_regclass('prototype_html_renders') AS t");
    if (!exists.rows[0]?.t) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(731942064)");
        await client.query(`CREATE TABLE IF NOT EXISTS prototype_html_renders (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES prototype_conversations(id) ON DELETE CASCADE,
          owner TEXT NOT NULL,
          title TEXT NOT NULL,
          height INTEGER NOT NULL,
          heights JSONB,
          html TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
        await client.query(
          "CREATE INDEX IF NOT EXISTS prototype_html_renders_owner ON prototype_html_renders (owner)",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return new PostgresRenderStore(pool);
  }
  private row = (r: Record<string, unknown>): StoredRender => ({
    id: String(r.id),
    owner: String(r.owner),
    conversationId: String(r.conversation_id),
    title: String(r.title),
    height: Number(r.height),
    ...(Array.isArray(r.heights) ? { heights: r.heights as Array<[number, number]> } : {}),
    html: String(r.html),
    bytes: Number(r.bytes),
    createdAt: new Date(r.created_at as string).toISOString(),
  });
  async put(row: Omit<StoredRender, "bytes" | "createdAt">, quotaBytes: number) {
    const bytes = Buffer.byteLength(row.html);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT * FROM prototype_html_renders WHERE id = $1", [
        row.id,
      ]);
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return this.row(existing.rows[0]);
      }
      // One owner's publishes are serialized, so the quota check cannot be raced past.
      await client.query("SELECT pg_advisory_xact_lock(731942065, hashtext($1))", [row.owner]);
      const used = await client.query(
        "SELECT COALESCE(SUM(bytes), 0)::bigint AS n FROM prototype_html_renders WHERE owner = $1",
        [row.owner],
      );
      if (Number(used.rows[0]?.n ?? 0) + bytes > quotaBytes) throw quotaError(quotaBytes);
      // Only for a conversation of this owner (the FK alone would accept another owner's id).
      const r = await client.query(
        `INSERT INTO prototype_html_renders (id, conversation_id, owner, title, height, heights, html, bytes)
           SELECT $1, c.id, c.owner, $4, $5, $6::jsonb, $7, $8
           FROM prototype_conversations c WHERE c.id = $2 AND c.owner = $3
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [
          row.id,
          row.conversationId,
          row.owner,
          row.title,
          row.height,
          row.heights ? JSON.stringify(row.heights) : null,
          row.html,
          bytes,
        ],
      );
      await client.query("COMMIT");
      if (!r.rows[0]) {
        const again = await this.get(row.id);
        if (again && again.owner === row.owner) return again;
        throw new ApiError(404, "Conversation not found");
      }
      return this.row(r.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async get(id: string) {
    const r = await this.pool.query("SELECT * FROM prototype_html_renders WHERE id = $1", [id]);
    return r.rows[0] ? this.row(r.rows[0]) : null;
  }
  async usage(owner: string) {
    const r = await this.pool.query(
      "SELECT COALESCE(SUM(bytes), 0)::bigint AS n FROM prototype_html_renders WHERE owner = $1",
      [owner],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
  close() {
    return this.pool.end();
  }
}

export interface VisualRepliesOptions {
  renderer: Renderer;
  store: RenderStore;
  /** The conversation's sandbox, through the files API (confined to /workspace). */
  readImage(owner: string, conversationId: string): SandboxImageReader;
  /** 404s for a missing or deleted conversation of this owner. */
  conversationExists(owner: string, conversationId: string): Promise<void>;
  signingKey: Buffer;
  urlTtlMs?: number;
  quotaBytes?: number;
  globalConcurrency?: number;
  perUserConcurrency?: number;
  /** Publishing waits this long for heights, then publishes without them (as upstream). */
  measureTimeoutMs?: number;
  now?: () => number;
}

export class VisualReplies {
  private readonly global: Gate;
  private readonly perUser = new Map<string, Gate>();
  private readonly ttl: number;
  private readonly quota: number;
  private readonly now: () => number;
  constructor(private readonly o: VisualRepliesOptions) {
    this.global = new Gate(o.globalConcurrency ?? 2, 16);
    this.ttl = o.urlTtlMs ?? 60 * 60_000;
    this.quota = o.quotaBytes ?? 200 * 1024 * 1024;
    this.now = o.now ?? Date.now;
  }
  private limited<T>(owner: string, fn: () => Promise<T>) {
    let gate = this.perUser.get(owner);
    if (!gate) this.perUser.set(owner, (gate = new Gate(this.o.perUserConcurrency ?? 1, 4)));
    const g = gate;
    return g
      .run(() => this.global.run(fn))
      .catch((e) => {
        if (e instanceof Error && e.message === "render queue is full")
          throw new ApiError(429, "Too many renders at once; try again shortly", "render_busy");
        throw e;
      })
      .finally(() => {
        if (g.busy === 0) this.perUser.delete(owner);
      });
  }
  /** html_preview / html_render, called by the broker for this conversation's tool call. */
  async execute(owner: string, conversationId: string, call: ToolCall): Promise<ToolResult> {
    const html = validHtml(call.args.html);
    const prepared = await preparePage(html, this.o.readImage(owner, conversationId));
    const missing = prepared.missing.length ? { missingImages: prepared.missing } : {};
    if (call.tool === "html_preview") {
      const width = validWidth(call.args.width);
      const appearance = call.args.appearance === "light" ? "light" : "dark";
      const out = await this.limited(owner, () =>
        this.o.renderer.render({
          html: prepared.html,
          fragment:
            appearance === "light"
              ? HTML_RENDER_MEASURE_FRAGMENT_LIGHT
              : HTML_RENDER_MEASURE_FRAGMENT_DARK,
          captureWidth: width,
        }),
      ).catch(renderFailure);
      const c = out.capture!;
      return {
        text: JSON.stringify({
          width,
          contentHeight: c.contentHeight,
          capturedHeight: c.capturedHeight,
          consoleMessages: out.consoleMessages,
          ...missing,
          screenshot: { mimeType: "image/png", width, height: c.capturedHeight },
        }),
        images: [{ mimeType: "image/png", data: c.png }],
        productionData: false,
      };
    }
    if (call.tool !== "html_render") throw new ApiError(400, "Invalid tool call");
    const title = validTitle(call.args.title);
    const height = validFrameHeight(call.args.height);
    // Deterministic per call, so a replayed call finds the page it already published.
    const id = `${createHash("sha256").update(`${owner}\0${conversationId}\0${call.id}`).digest("hex").slice(0, 32)}-html`;
    const heights = await this.limited(owner, () =>
      withTimeout(
        this.o.renderer.render({
          html: prepared.html,
          fragment: HTML_RENDER_MEASURE_FRAGMENT_DARK,
          measureWidths: HTML_RENDER_MEASURE_WIDTHS,
        }),
        this.o.measureTimeoutMs ?? 8_000,
      ),
    )
      .then((o) =>
        o.heights?.map(
          ([w, h]) => [w, Math.min(2000, Math.max(80, Math.round(h)))] as [number, number],
        ),
      )
      // As upstream: a page that cannot be measured is published without heights.
      .catch(() => undefined);
    const stored = await this.o.store.put(
      {
        id,
        owner,
        conversationId,
        title,
        height,
        ...(heights?.length ? { heights } : {}),
        html: prepared.html,
      },
      this.quota,
    );
    return {
      text: JSON.stringify({
        htmlRender: {
          attachmentId: stored.id,
          title: stored.title,
          height: stored.height,
          ...(stored.heights ? { heights: stored.heights } : {}),
        },
        message: RENDER_RESULT_MESSAGE,
        ...missing,
      }),
      productionData: false,
    };
  }
  private sign(id: string, owner: string, conversationId: string, expiresAt: number) {
    return createHmac("sha256", this.o.signingKey)
      .update(`linguini-render\n${id}\n${owner}\n${conversationId}\n${expiresAt}`)
      .digest("base64url");
  }
  /** assets.createUrl for an html render: only the owner's own, live conversation. */
  async mintUrl(owner: string, attachmentId: unknown) {
    if (typeof attachmentId !== "string" || !RENDER_ID.test(attachmentId))
      throw new ApiError(404, "Render not found");
    const row = await this.o.store.get(attachmentId);
    if (!row || row.owner !== owner) throw new ApiError(404, "Render not found");
    await this.o.conversationExists(owner, row.conversationId);
    const expiresAt = this.now() + this.ttl;
    const q = new URLSearchParams({
      c: row.conversationId,
      e: String(expiresAt),
      s: this.sign(row.id, row.owner, row.conversationId, expiresAt),
    });
    return { relativeUrl: `/render/${row.id}.html?${q}`, expiresAt };
  }
  /**
   * GET /render/<id>.html: `requester` is the signed-in owner (cookie or tailnet), or null for a
   * request that carries no session (e.g. token mode). A different signed-in user is refused.
   */
  async serve(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    requester: string | null,
  ) {
    const deny = (status: number, text: string) => {
      response.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(text);
    };
    if (request.method !== "GET" && request.method !== "HEAD")
      return deny(405, "Method not allowed");
    const m = /^\/render\/([a-f0-9]{32}-html)\.html$/.exec(url.pathname);
    const c = url.searchParams.get("c") ?? "";
    const e = Number(url.searchParams.get("e"));
    const s = url.searchParams.get("s") ?? "";
    if (!m || !c || !Number.isSafeInteger(e) || !s) return deny(404, "Not found");
    if (e < this.now()) return deny(403, "Link expired");
    const row = await this.o.store.get(m[1]!);
    if (!row || row.conversationId !== c) return deny(404, "Not found");
    const want = Buffer.from(this.sign(row.id, row.owner, row.conversationId, e));
    const got = Buffer.from(s);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return deny(403, "Invalid link");
    if (requester !== null && requester !== row.owner) return deny(403, "Not your render");
    try {
      await this.o.conversationExists(row.owner, row.conversationId);
    } catch {
      return deny(404, "Not found");
    }
    response.removeHeader("Service-Worker-Allowed");
    response.removeHeader("Clear-Site-Data");
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": RENDER_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, max-age=300",
      "content-length": Buffer.byteLength(row.html),
    });
    response.end(request.method === "HEAD" ? undefined : row.html);
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (err) => (clearTimeout(t), reject(err)),
    );
  });
const renderFailure = (e: unknown): never => {
  if (e instanceof ApiError) throw e;
  throw new ApiError(
    502,
    `The page could not be rendered: ${e instanceof Error ? e.message : String(e)}`,
  );
};

/** The key for render URLs: derived from the auth secret, or random per process. */
export function renderSigningKey(secret?: string) {
  return secret
    ? createHmac("sha256", secret).update("linguini-render-url").digest()
    : randomBytes(32);
}
export { HTML_RENDER_COLUMN_WIDTH };
