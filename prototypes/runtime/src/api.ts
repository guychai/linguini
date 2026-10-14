import type { ConversationDeleter } from "./deletion.ts";
import { applySettle, promoteOnPin, SETTLE_ACTIONS, type SettleAction } from "./settlement.ts";
import { browserCsp } from "./browser-policy.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { body } from "./gateway.ts";
import { ApiError, EVENT_PAGE_DEFAULT, initial, read, append, type Conversation } from "./store.ts";
import { unresolved } from "./ledger.ts";
import { Engine, type Command } from "./engine.ts";
import type { TerminalManager } from "./terminal.ts";
import { attachTerminalStreams, originAllowed, terminalHttp } from "./terminal-api.ts";
import type { SandboxFiles } from "./files.ts";
import {
  browserRequestAllowed,
  fromPreview,
  PreviewProxy,
  validPort,
  type PreviewPortStore,
} from "./preview.ts";
import { ADMIN_ROLE, type LinguiniAuth, type SessionUser } from "./auth.ts";
import type { AccountAdmin } from "./accounts.ts";
import {
  effectiveModel,
  validateSettings,
  type SettingsPolicy,
  type SettingsStore,
} from "./users.ts";

export type TokenBindings = Record<string, string>;
export function publicConversation(c: Conversation) {
  return {
    id: c.id,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    title: c.title,
    metadata: c.metadata ?? {},
    tainted: c.tainted,
    sandboxAllocated: c.sandbox !== null,
    jobs: c.jobs,
    events: c.events,
    // Unknown tool outcomes block further work until resolved via .../ledger/:execId/resolve.
    toolOutcomesUnknown: unresolved(c).map(
      ({ execId, callId, tool, destination, error, lateObservations }) => ({
        execId,
        callId,
        tool,
        destination,
        reason: error,
        // Evidence only: what a stale worker reported after losing the call.
        lateObservations: (lateObservations ?? []).map((o) => ({
          epoch: o.epoch,
          currentEpoch: o.currentEpoch,
          text: o.result.text.slice(0, 2000),
        })),
      }),
    ),
  };
}
export function api(
  engine: Engine,
  bindings: TokenBindings,
  webDist?: string,
  options: {
    /**
     * AUTH_MODE=better-auth: owner = the Better Auth user id of the session cookie (auth.ts);
     * /api/auth/* is Better Auth's own routes. Without it AUTH_MODE=tailnet or bearer tokens apply.
     */
    auth?: {
      auth: LinguiniAuth;
      settings: SettingsStore;
      policy: SettingsPolicy;
      /** Admin Users page (accounts.ts); absent: /api/admin/* is a 404. */
      accounts?: AccountAdmin;
      /** Called for every authenticated user (e.g. so recovery loops know the owner). */
      onUser?: (user: SessionUser) => void;
    };
    /** Conversation deletion (deletion.ts); absent: DELETE is a 501. */
    deleter?: Pick<ConversationDeleter, "tombstone" | "finish">;
    terminals?: TerminalManager;
    /** Read-only Files panel over the conversation's sandbox /workspace (files.ts). */
    files?: Pick<SandboxFiles, "list" | "read" | "search" | "write">;
    previews?: {
      ports: PreviewPortStore;
      proxy?: (resolveOwner: (r: IncomingMessage) => Promise<string | undefined>) => PreviewProxy;
      /** User toggle from the UI: same effect as the agent's share_port / unshare_port. */
      share?: (
        owner: string,
        id: string,
        args: Record<string, unknown>,
        tool: "share_port" | "unshare_port",
      ) => Promise<unknown>;
      baseUrl?: (id: string) => string;
    };
  } = {},
) {
  const tokens = Object.entries(bindings).map(([token, owner]) => ({
    hash: createHash("sha256").update(token).digest(),
    owner,
  }));
  if (!tokens.length || Object.keys(bindings).some((token) => token.length < 32))
    throw new Error("Configure owner bearer tokens with at least 32 characters");
  const streams = new Set<ServerResponse>();
  // AUTH_MODE=tailnet: network access (Tailscale ACLs + a tailnet-only bind) is the gate;
  // every request acts as TAILNET_OWNER (default local-owner). A valid token still wins.
  // AUTH_MODE=better-auth (options.auth): the Better Auth session cookie's user id. A valid token
  // still wins (service clients).
  const users = options.auth;
  const authenticate = async (
    request: IncomingMessage,
    wsToken?: string,
  ): Promise<{ owner: string; user: SessionUser | null; viaToken?: true } | undefined> => {
    const bearer = wsToken ?? request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
    const hash = createHash("sha256").update(bearer).digest();
    const bound = tokens.find((token) => timingSafeEqual(token.hash, hash))?.owner;
    if (bound) return { owner: bound, user: null, viaToken: true };
    if (users) {
      const user = await users.auth.user(request);
      if (!user) return undefined;
      users.onUser?.(user);
      return { owner: user.id, user };
    }
    if (process.env.AUTH_MODE === "tailnet")
      return { owner: process.env.TAILNET_OWNER ?? "local-owner", user: null };
    return undefined;
  };
  const resolveOwner = async (request: IncomingMessage, wsToken?: string) =>
    (await authenticate(request, wsToken))?.owner;
  /**
   * Terminal WebSocket: like resolveOwner, but browser credentials need an Origin that matches
   * the Host. Browsers do not send Sec-Fetch-Site on WebSocket handshakes, so Origin is the check
   * here (Origin "null" and /preview/ Referers are already refused in terminal-api.ts).
   */
  const resolveSocketOwner = async (request: IncomingMessage, wsToken?: string) => {
    const auth = await authenticate(request, wsToken);
    if (auth && !auth.viaToken && (!request.headers.origin || !originAllowed(request)))
      throw new ApiError(403, "Cross-site request refused");
    return auth?.owner;
  };
  const conversationExists = async (owner: string, id: string) => {
    await engine.store.snapshot(owner, id, { events: false });
  };
  const previewProxy = options.previews?.proxy?.((r) => resolveOwner(r));
  const server = createServer(async (request, response) => {
    // Preview traffic is the sandbox app's, with its own headers (never Linguini's CSP/API).
    if (previewProxy && (request.url ?? "").startsWith("/preview/"))
      return void previewProxy.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
        else response.destroy();
      });
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", browserCsp);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        json(200, {
          ok: true,
          backend: "owned-postgres-pi",
          harness: process.env.HARNESS_MODE === "pi" ? "pi" : "fixture",
          model: process.env.PI_MODEL ?? "claude-sonnet-4-5",
          thinkingLevel: process.env.PI_THINKING_LEVEL ?? null,
        });
        return;
      }
      if (!url.pathname.startsWith("/api/") && request.method === "GET" && webDist) {
        // The app shell holds no data; it shows the sign-in screen when /api/session is a 401.
        const root = await realpath(webDist);
        let file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
        if (file !== root && !file.startsWith(root + sep))
          throw new ApiError(403, "Invalid static path");
        try {
          if (!(await stat(file)).isFile()) file = resolve(root, "index.html");
        } catch {
          file = resolve(root, "index.html");
        }
        const actual = await realpath(file);
        if (!actual.startsWith(root + sep)) throw new ApiError(403, "Invalid static path");
        response.setHeader(
          "content-type",
          (
            {
              ".html": "text/html",
              ".js": "application/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".woff2": "font/woff2",
              ".wasm": "application/wasm",
            } as Record<string, string>
          )[extname(actual)] ?? "application/octet-stream",
        );
        // index.html (and anything not content-hashed) must revalidate so a new build is picked
        // up; hashed /assets/* are immutable.
        response.setHeader(
          "cache-control",
          url.pathname.startsWith("/assets/") && actual !== resolve(root, "index.html")
            ? "public, max-age=31536000, immutable"
            : "no-cache, must-revalidate",
        );
        const contents = await readFile(actual);
        if (extname(actual) === ".html") {
          const hashes = [...contents.toString().matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
            (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
          );
          response.setHeader(
            "Content-Security-Policy",
            browserCsp.replace("script-src 'self'", `script-src 'self' ${hashes.join(" ")}`),
          );
        }
        response.end(contents);
        return;
      }
      // Pages served under /preview/ (sandbox apps) must never drive Linguini's API.
      if (fromPreview(request)) throw new ApiError(403, "Requests from preview pages are refused");
      if (users && url.pathname.startsWith("/api/auth/")) {
        if (
          request.method !== "GET" &&
          !originAllowed(request, users.auth.trustedOrigins.join(","))
        )
          throw new ApiError(403, "Cross-origin request refused");
        // The admin plugin's own routes stay private: /api/admin/* below is the admin API.
        if (url.pathname.startsWith("/api/auth/admin/")) throw new ApiError(404, "Not found");
        if (url.pathname === "/api/auth/linguini-config" && request.method === "GET") {
          json(200, { signupEnabled: users.auth.signupEnabled });
          return;
        }
        // Better Auth sets its own headers; ours (CSP etc.) stay.
        await users.auth.handle(request, response);
        return;
      }
      const auth = await authenticate(request);
      if (!auth)
        throw new ApiError(
          401,
          users ? "Sign in required" : "Authentication required",
          "unauthenticated",
        );
      if (!auth.viaToken && !browserRequestAllowed(request))
        throw new ApiError(403, "Cross-site request refused", "cross_site");
      const owner = auth.owner;
      if (request.method !== "GET" && !originAllowed(request))
        throw new ApiError(403, "Cross-origin request refused");
      if (
        options.terminals &&
        (await terminalHttp(options.terminals, conversationExists, owner, request, response, url))
      )
        return;
      const filesRoute =
        /^\/api\/conversations\/([a-zA-Z0-9_-]{1,100})\/files\/(list|read|search|write)$/.exec(
          url.pathname,
        );
      if (filesRoute) {
        if (!options.files) throw new ApiError(501, "Files are not available on this node");
        if (request.method !== "POST") throw new ApiError(405, "Method not allowed");
        const [, id, op] = filesRoute;
        await conversationExists(owner, id!);
        // Writes carry up to 5 MiB of contents; JSON escaping can grow that, so allow headroom.
        const input = (await body(request, op === "write" ? 24_000_000 : undefined)) as Record<
          string,
          unknown
        >;
        json(
          200,
          op === "write"
            ? await options.files.write(
                owner,
                id!,
                input.path,
                input.contents,
                input.expectedVersion,
              )
            : op === "list"
              ? await options.files.list(owner, id!, input.path)
              : op === "read"
                ? await options.files.read(owner, id!, input.path)
                : await options.files.search(owner, id!, input.query, input.limit),
        );
        return;
      }
      const previewRoute = /^\/api\/conversations\/([^/]+)\/previews(?:\/(\d{1,5}))?$/.exec(
        url.pathname,
      );
      if (previewRoute && options.previews) {
        const id = decodeURIComponent(previewRoute[1]!);
        await conversationExists(owner, id);
        const { ports, share, baseUrl } = options.previews;
        if (request.method === "GET" && !previewRoute[2]) {
          const list = await ports.list(owner, id);
          json(200, {
            previews: list.map((p) => ({
              ...p,
              url: baseUrl ? `${baseUrl(id)}/${p.port}/` : null,
            })),
          });
          return;
        }
        if (!share) throw new ApiError(501, "Preview sharing is not configured");
        if (request.method === "POST" && !previewRoute[2]) {
          const input = (await body(request)) as Record<string, unknown>;
          json(200, { result: await share(owner, id, input, "share_port") });
          return;
        }
        if (request.method === "DELETE" && previewRoute[2]) {
          json(200, {
            result: await share(owner, id, { port: validPort(previewRoute[2]) }, "unshare_port"),
          });
          return;
        }
        throw new ApiError(405, "Method not allowed");
      }
      if (url.pathname === "/api/session" && request.method === "GET") {
        const u = auth.user;
        json(200, {
          owner,
          user: u ? { id: u.id, email: u.email, name: u.name, admin: u.role === ADMIN_ROLE } : null,
        });
        return;
      }
      if (url.pathname.startsWith("/api/admin/")) {
        // Not an admin (or no admin API): the routes do not exist.
        if (!users?.accounts || auth.user?.role !== ADMIN_ROLE)
          throw new ApiError(404, "Not found");
        const accounts = users.accounts;
        if (url.pathname === "/api/admin/users" && request.method === "GET") {
          json(200, { users: await accounts.users(request) });
          return;
        }
        const m = /^\/api\/admin\/users\/([^/]{1,200})(\/password)?$/.exec(url.pathname);
        const userId = m ? decodeURIComponent(m[1]!) : "";
        if (m && !m[2] && request.method === "DELETE") {
          json(200, { deleted: true, ...(await accounts.deleteUser(request, owner, userId)) });
          return;
        }
        if (m && m[2] && request.method === "POST") {
          const input = ((await body(request)) ?? {}) as { password?: unknown };
          json(200, await accounts.resetPassword(request, owner, userId, input.password));
          return;
        }
        throw new ApiError(404, "Not found");
      }
      if (url.pathname === "/api/me/settings") {
        if (!users || !auth.user)
          throw new ApiError(501, "Per-user settings need AUTH_MODE=better-auth");
        const describe = (settings: Awaited<ReturnType<SettingsStore["settings"]>>) => ({
          settings,
          allowed: {
            models: users.policy.models,
            thinkingLevels: users.policy.thinkingLevels,
          },
          effective: effectiveModel(settings, users.policy),
        });
        if (request.method === "GET") {
          json(200, describe(await users.settings.settings(owner)));
          return;
        }
        if (request.method === "PUT" || request.method === "PATCH") {
          const current = await users.settings.settings(owner);
          const next = validateSettings(await body(request), current, users.policy);
          json(200, describe(await users.settings.saveSettings(owner, next)));
          return;
        }
        throw new ApiError(405, "Method not allowed");
      }
      if (url.pathname === "/api/changes" && request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        response.flushHeaders();
        streams.add(response);
        const changed = (changedOwner: string, id: string) => {
          if (changedOwner === owner) response.write(`data: ${JSON.stringify({ id })}\n\n`);
        };
        engine.store.changes?.on("commit", changed);
        response.write('data: {"id":null}\n\n');
        const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15000);
        response.on("close", () => {
          clearInterval(heartbeat);
          engine.store.changes?.off("commit", changed);
          streams.delete(response);
        });
        return;
      }
      if (url.pathname === "/api/conversations") {
        if (request.method === "GET") {
          const limit = url.searchParams.get("limit");
          if (limit !== null && !/^[1-9][0-9]{0,3}$/.test(limit))
            throw new ApiError(400, "Invalid page limit");
          const cursor = url.searchParams.get("cursor");
          if (cursor !== null && !/^[a-zA-Z0-9_-]{1,100}$/.test(cursor))
            throw new ApiError(400, "Invalid page cursor");
          const page = await engine.store.list(owner, {
            events: true,
            ...(limit === null ? {} : { limit: Number(limit) }),
            ...(cursor === null ? {} : { after: cursor }),
          });
          // The body stays a plain array; the next page's cursor rides in a header.
          if (page.next !== null) response.setHeader("x-next-cursor", page.next);
          json(200, page.items.map(publicConversation));
          return;
        }
        if (request.method === "POST") {
          const input = await body(request);
          if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id))
            throw new ApiError(400, "Invalid conversation ID");
          const title =
            typeof input.title === "string" ? input.title.slice(0, 200) : "New conversation";
          await engine.store.create(initial(input.id, owner, title));
          json(201, publicConversation(await read(engine.store, owner, input.id)));
          return;
        }
      }
      const resolution = url.pathname.match(
        /^\/api\/conversations\/([a-zA-Z0-9_-]{1,100})\/ledger\/(x[0-9a-f]{32})\/resolve$/,
      );
      if (resolution && request.method === "POST") {
        const [, id, execId] = resolution;
        const input = await body(request);
        if (input.outcome !== "applied" && input.outcome !== "not-applied")
          throw new ApiError(400, 'outcome must be "applied" or "not-applied"');
        await engine.resolveToolOutcome(
          owner,
          id!,
          execId!,
          input.outcome,
          typeof input.note === "string" ? input.note : undefined,
        );
        json(200, publicConversation(await read(engine.store, owner, id!)));
        return;
      }
      const match = url.pathname.match(
        /^\/api\/conversations\/([a-zA-Z0-9_-]{1,100})(?:\/(commands|events|metadata))?$/,
      );
      if (match) {
        const [, id, operation] = match;
        if (!operation && request.method === "GET") {
          json(200, publicConversation(await read(engine.store, owner, id)));
          return;
        }
        if (!operation && request.method === "DELETE") {
          if (!options.deleter) throw new ApiError(501, "Conversation deletion is not configured");
          // Tombstone first: from here the conversation is gone for every reader (404 if it
          // never existed or was already purged, which keeps a retried DELETE harmless).
          await options.deleter.tombstone(owner, id!);
          try {
            const r = await options.deleter.finish(owner, id!);
            json(200, {
              deleted: true,
              pending: false,
              removed: {
                jobs: r.jobs.length,
                network: r.network,
                policy: r.policy,
                objects: r.objects.length,
                rows: r.rows,
              },
            });
          } catch (error) {
            // Cleanup continues in the background sweeper; the conversation is already gone.
            console.log(
              `conversation delete pending (${id}): ${error instanceof Error ? error.message : error}`,
            );
            json(202, { deleted: true, pending: true });
          }
          return;
        }
        if (operation === "metadata" && request.method === "POST") {
          const value = await body(request);
          if (
            typeof value.commandId !== "string" ||
            !value.commandId ||
            value.commandId.length > 200
          )
            throw new ApiError(400, "Invalid metadata command ID");
          const allowed = [
            "commandId",
            "title",
            "archivedAt",
            "pinnedAt",
            "lastVisitedAt",
            "orderKey",
            "pinOrderKey",
            "activeOrderKey",
            "settle",
          ];
          if (Object.keys(value).some((key) => !allowed.includes(key)))
            throw new ApiError(403, "Unsupported metadata operation");
          for (const [key, entry] of Object.entries(value))
            if (
              key !== "commandId" &&
              entry !== null &&
              (typeof entry !== "string" || entry.length > 200)
            )
              throw new ApiError(400, "Invalid metadata value");
          if ("settle" in value && !SETTLE_ACTIONS.includes(value.settle as SettleAction))
            throw new ApiError(400, "Invalid settle action");
          if (typeof value.title === "string" && !value.title.trim())
            throw new ApiError(400, "Empty title");
          const { fingerprint } = await import("./sandbox.ts");
          await engine.store.mutate(owner, id, (c) => {
            const key = `metadata:${value.commandId}`,
              hash = fingerprint(value),
              existing = c.receipts[key];
            if (existing) {
              if (existing.fingerprint !== hash)
                throw new ApiError(409, "Command ID reused with a different payload");
              return;
            }
            if (typeof value.title === "string") c.title = value.title;
            c.metadata ??= {};
            const meta = c.metadata,
              alreadyPinned = meta.pinnedAt != null;
            for (const key of ["archivedAt", "pinnedAt", "lastVisitedAt", "orderKey"] as const)
              if (key in value)
                meta[key] =
                  value[key] === "now" ? new Date().toISOString() : (value[key] as string | null);
            // Pin and Active order keys are separate slots (T3 thread.pin.reorder /
            // thread.active.reorder). A fresh pin may carry its slot; a re-pin keeps the
            // existing key; unpin clears the pin slot.
            if ("pinOrderKey" in value && !(alreadyPinned && "pinnedAt" in value && value.pinnedAt))
              meta.pinOrderKey = value.pinOrderKey as string | null;
            if ("pinnedAt" in value && value.pinnedAt === null) meta.pinOrderKey = null;
            if ("activeOrderKey" in value)
              meta.activeOrderKey = value.activeOrderKey as string | null;
            if ("pinnedAt" in value && value.pinnedAt && !alreadyPinned) promoteOnPin(meta);
            if ("settle" in value)
              applySettle(meta, value.settle as SettleAction, new Date().toISOString());
            c.receipts[key] = { fingerprint: hash, result: true };
            const priorUpdatedAt = c.updatedAt;
            append(c, "metadata.updated", { ...meta });
            // Visiting or arranging the Active list is not thread activity.
            if (
              Object.keys(value).every((k) =>
                ["commandId", "lastVisitedAt", "activeOrderKey"].includes(k),
              )
            )
              c.updatedAt = priorUpdatedAt;
          });
          json(200, publicConversation(await read(engine.store, owner, id)));
          return;
        }
        if (operation === "commands" && request.method === "POST") {
          const value = await body(request);
          if (
            value.messageId !== undefined &&
            (typeof value.messageId !== "string" || value.messageId.length > 200)
          )
            throw new ApiError(400, "Invalid message ID");
          const command: Command = {
            commandId: String(value.commandId ?? ""),
            kind: value.kind as Command["kind"],
            ...(typeof value.jobId === "string" ? { jobId: value.jobId } : {}),
            ...(typeof value.beforeJobId === "string" || value.beforeJobId === null
              ? { beforeJobId: value.beforeJobId }
              : {}),
            ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
            ...(typeof value.text === "string" ? { text: value.text } : {}),
            ...(typeof value.targetJobId === "string" ? { targetJobId: value.targetJobId } : {}),
          };
          json(202, await engine.command(owner, id, command));
          return;
        }
        if (operation === "events" && request.method === "GET") {
          let cursor = Number(
            url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0",
          );
          if (!Number.isSafeInteger(cursor) || cursor < 0)
            throw new ApiError(400, "Invalid reconnect cursor");
          const c = await engine.store.snapshot(owner, id, { events: false });
          if (cursor > (c.lastSeq ?? 0))
            throw new ApiError(409, "Reconnect cursor ahead of durable history");
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          response.flushHeaders();
          streams.add(response);
          let chain = Promise.resolve();
          const key = JSON.stringify([owner, id]);
          const flush = () => {
            chain = chain
              .then(async () => {
                // Catch up one bounded page at a time instead of loading the whole history.
                for (;;) {
                  const page = await engine.store.events(owner, id, cursor, EVENT_PAGE_DEFAULT);
                  for (const event of page)
                    if (event.seq > cursor) {
                      response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
                      cursor = event.seq;
                    }
                  if (page.length < EVENT_PAGE_DEFAULT || response.destroyed) break;
                }
              })
              .catch(() => {
                response.end();
              });
          };
          // Register before taking the catch-up snapshot to avoid a snapshot/live gap.
          engine.changes.on(key, flush);
          flush();
          const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
          response.on("close", () => {
            clearInterval(heartbeat);
            engine.changes.off(key, flush);
            streams.delete(response);
          });
          return;
        }
      }
      throw new ApiError(404, "Unsupported route; worktrees and Git are deferred");
    } catch (error) {
      if (!response.headersSent)
        json(error instanceof ApiError ? error.status : 500, {
          error: error instanceof ApiError ? error.message : "Internal error",
          ...(error instanceof ApiError && error.code ? { code: error.code } : {}),
        });
      else response.end();
    }
  });
  server.on("upgrade", (request: IncomingMessage, socket, head: Buffer) => {
    if (!(request.url ?? "").startsWith("/preview/")) return;
    if (previewProxy) void previewProxy.upgrade(request, socket, head);
    else socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  if (options.terminals)
    attachTerminalStreams(server, options.terminals, resolveSocketOwner, conversationExists);
  return {
    server,
    closeStreams: () => {
      for (const response of streams) response.end();
    },
  };
}
