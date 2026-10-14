import * as C from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import {
  RpcSessionFactory,
  type RpcSession,
} from "../../../packages/client-runtime/src/rpc/session.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "../../../packages/client-runtime/src/connection/model.ts";
import { LiveFeed, type FeedFailure } from "./live-feed.ts";
import type { WsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import { OwnedAdapter, OwnedApiError, type Conversation } from "./adapter.ts";
import {
  rejectedSteers,
  resendCommandId,
  showSteerNotice,
  type RejectedSteer,
} from "./steer-notice.ts";
import {
  TERMINAL_COMMANDS,
  TERMINAL_STREAMS,
  terminalCommand,
  terminalStream,
  type TerminalDeps,
} from "./terminal-client.ts";
import { FILE_COMMANDS, fileCommand } from "./files-client.ts";
import { showFileNotice } from "./file-notice.ts";
import { syncOutcomeNotice, type Outcome } from "./outcome-notice.ts";
import { syncWorkspaceNotice } from "./workspace-notice.ts";
import { clearPreviewChip, syncPreviewChip } from "./preview-chip.ts";
import {
  auth,
  decode,
  descriptor,
  projection,
  serverConfig,
  shell,
  scopes,
  configureHarness,
} from "./projection.ts";
import { renderAssetUrl } from "./render-assets.ts";

const originalFetch = globalThis.fetch.bind(globalThis);
const token = () => sessionStorage.getItem("owned-prototype-token") ?? "";
const owned = () => new OwnedAdapter(token(), originalFetch);
const terminalDeps = (): TerminalDeps => ({
  fetch: originalFetch,
  token,
  WebSocket: globalThis.WebSocket,
  location: globalThis.location,
});
const wire = <S extends Schema.Codec<any, any, never, never>>(schema: S, value: S["Type"]) =>
  Schema.encodeSync(Schema.toCodecJson(schema))(value) as Record<string, any>;
const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" ? (value as Record<string, any>) : {};
async function request(path: string, data?: unknown) {
  const response = await originalFetch(path, {
    method: data === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok)
    throw new Error(
      `Owned backend ${response.status}: ${((await response.json()) as { error?: string }).error ?? "Request denied"}`,
    );
  return response;
}
async function metadata(input: Record<string, any>) {
  const id = String(input.threadId),
    value: Record<string, unknown> = { commandId: input.commandId };
  const date = "now";
  switch (input.type) {
    case "thread.metadata.update":
      if (Object.keys(input).some((k) => !["type", "commandId", "threadId", "title"].includes(k)))
        throw new Error("Unsupported thread metadata");
      value.title = input.title;
      break;
    case "thread.archive":
      value.archivedAt = date;
      break;
    case "thread.unarchive":
      value.archivedAt = null;
      break;
    case "thread.pin":
      value.pinnedAt = date;
      if (typeof input.orderKey === "string") value.pinOrderKey = input.orderKey;
      break;
    case "thread.unpin":
      value.pinnedAt = null;
      break;
    case "thread.visit":
      value.lastVisitedAt = input.visitedAt;
      break;
    case "thread.mark-unread":
      value.lastVisitedAt = null;
      break;
    // Explicit settlement (T3 thread.settle / thread.unsettle); the backend owns timestamps.
    case "thread.settle":
      value.settle = "settled";
      break;
    case "thread.unsettle":
      value.settle = "active";
      break;
    case "thread.pin.reorder":
      value.pinOrderKey = input.orderKey;
      break;
    case "thread.active.reorder":
      value.activeOrderKey = input.orderKey;
      break;
    default:
      throw new Error(`Unsupported command: ${input.type}`);
  }
  await request(`/api/conversations/${id}/metadata`, value);
}
/** The shell snapshotSequence that includes every write that finished before `rows` was read. */
export const confirmedShellSequence = (rows: Conversation[]) => shell(rows).snapshotSequence;
export async function invoke(tag: string, raw: unknown): Promise<unknown> {
  const input = record(raw),
    a = owned();
  if (tag === "server.getConfig") return serverConfig();
  if (tag === "server.getSettings") return serverConfig().settings;
  if (tag === "server.probe") {
    await a.session();
    return { ok: true };
  }
  if (tag === "server.refreshProviders") return { issues: [], providers: serverConfig().providers };
  if (tag === "server.reportClientActivity") return undefined;
  if ((TERMINAL_COMMANDS as readonly string[]).includes(tag))
    return terminalCommand(tag, input, terminalDeps());
  // Files panel: read-only browsing of the current conversation's sandbox /workspace.
  if ((FILE_COMMANDS as readonly string[]).includes(tag))
    return fileCommand(tag, input, {
      fetch: originalFetch,
      token,
      location: globalThis.location,
      notify: (text) => showFileNotice(text),
    });
  // File chips ask for host file metadata; the browser never sees host paths, so every
  // entry is "unknown" (null) and chips fall back to their name-based icon.
  // Visual replies (html_render): the card's page URL.
  if (tag === "assets.createUrl") return renderAssetUrl(input.resource, request);
  if (tag === "filesystem.getMetadata")
    return { entries: (input.paths as unknown[]).map(() => null) };
  // Automations are not part of the owned backend: an empty, read-only list.
  if (tag === "scheduledTasks.list") return { tasks: [] };
  if (tag === "orchestration.getThreadProjection")
    return projection(await a.snapshot(input.threadId));
  if (tag === "orchestration.getTurnItem")
    return {
      item:
        projection(await a.snapshot(input.threadId)).turnItems.find((i) => i.id === input.itemId) ??
        null,
    };
  if (tag === "orchestration.getArchivedShellSnapshot") {
    const s = shell(await a.list());
    return {
      snapshotSequence: s.snapshotSequence,
      projects: s.projects,
      threads: s.archivedThreads,
    };
  }
  if (tag === "orchestration.launchThread") {
    if (
      input.projectId !== "owned-project" ||
      input.workspaceStrategy?.type !== "root" ||
      input.importedNativeThread ||
      input.modelSelection?.instanceId !== "pi" ||
      input.initialMessage?.attachments?.length ||
      input.initialMessage?.context
    )
      throw new Error("Unsupported launch outside the owned conversation boundary");
    const id = String(input.threadId ?? `thread-${input.commandId}`);
    await a.create(id, input.title);
    if (input.initialMessage?.text)
      await a.command(id, {
        commandId: input.commandId,
        kind: "prompt",
        messageId: input.initialMessage.messageId,
        text: input.initialMessage.text,
      });
    return {
      threadId: C.ThreadId.make(id),
      projection: projection(await a.snapshot(id)),
      resumed: false,
    };
  }
  if (tag === "orchestration.dispatchCommand") {
    const id = String(input.threadId);
    if (input.type === "message.dispatch") {
      if (
        input.attachments?.length ||
        input.context ||
        (input.modelSelection && input.modelSelection.instanceId !== "pi")
      )
        throw new Error("Attachments, host context and alternate providers are disabled");
      const mode = input.dispatchMode?.type;
      if (!["start_immediately", "queue_after_active", "steer_active"].includes(mode))
        throw new Error(`Unsupported dispatch mode: ${mode}`);
      try {
        await a.command(id, {
          commandId: input.commandId,
          messageId: input.messageId,
          kind:
            mode === "steer_active" ? "steer" : mode === "queue_after_active" ? "queue" : "prompt",
          text: input.text,
          ...(mode === "steer_active"
            ? { targetJobId: String(input.dispatchMode.targetRunId) }
            : {}),
        });
      } catch (error) {
        // A stale steer is refused, never converted; offer to send it as a new message.
        if (error instanceof OwnedApiError && error.code === "STEER_TARGET_NOT_ACTIVE")
          showSteerNotice(
            { threadId: id, steerId: String(input.commandId), text: String(input.text) },
            resendSteer,
          );
        throw error;
      }
    } else if (
      ["queued-run.cancel", "queued-run.edit", "queued-run.reorder"].includes(input.type)
    ) {
      if (input.context || input.attachments?.length)
        throw new Error("Queued host context and attachments are disabled");
      await a.command(id, {
        commandId: input.commandId,
        kind:
          input.type === "queued-run.cancel"
            ? "queue_cancel"
            : input.type === "queued-run.edit"
              ? "queue_edit"
              : "queue_reorder",
        jobId: input.runId,
        beforeJobId: input.beforeRunId,
        text: input.text,
      });
    } else if (input.type === "run.interrupt" || input.type === "thread.stop")
      await a.command(id, { commandId: input.commandId, kind: "cancel" });
    else if (input.type === "thread.delete") {
      await a.deleteConversation(id);
      return { sequence: confirmedShellSequence(await a.list()) };
    } else {
      await metadata(input);
      // Sidebar lifecycle commands (settle, pin, archive, reorder...) are reconciled by the
      // client against the *shell* snapshotSequence (upstream: one global sequence), so the
      // acknowledgement must use the same measure, read after the write.
      return { sequence: confirmedShellSequence(await a.list()) };
    }
    return { sequence: (await a.snapshot(id)).events.at(-1)?.seq ?? 0 };
  }
  // No best-effort success for unsupported filesystem, shell, Git, export or setup operations.
  throw new Error(`Owned adapter denies unsupported RPC: ${tag}`);
}
async function resendSteer(steer: RejectedSteer) {
  await owned().command(steer.threadId, {
    commandId: resendCommandId(steer),
    kind: "prompt",
    text: steer.text,
  });
}
function noticeRejectedSteers(c: Conversation) {
  for (const steer of rejectedSteers(c)) showSteerNotice(steer, resendSteer);
}
async function resolveOutcome(threadId: string, execId: string, outcome: Outcome) {
  await owned().resolveToolOutcome(threadId, execId, outcome);
}
/** Map a backend/transport failure to the T3 supervisor's error vocabulary. */
export function connectionError(error: unknown) {
  const status = error instanceof OwnedApiError ? error.status : undefined;
  if (status === 401 || status === 403)
    return new ConnectionBlockedError({
      reason: "authentication",
      detail: `Owner token rejected (HTTP ${status}). Sign in again.`,
    });
  if (error instanceof TypeError)
    return new ConnectionTransientError({ reason: "network", detail: String(error.message) });
  return new ConnectionTransientError({
    reason: status ? "remote-unavailable" : "transport",
    detail: String(error instanceof Error ? error.message : error),
  });
}
export function feedFailureError(failure: FeedFailure) {
  return failure.kind === "auth"
    ? new ConnectionBlockedError({
        reason: "authentication",
        detail: `${failure.detail}. Sign in again.`,
      })
    : new ConnectionTransientError({ reason: "remote-unavailable", detail: failure.detail });
}
export function createFeed(fetchFn: typeof fetch = originalFetch) {
  return new LiveFeed({
    url: "/api/changes",
    fetch: fetchFn,
    headers: () => ({ authorization: `Bearer ${token()}` }),
  });
}
function subscription(tag: string, raw: unknown, feed?: LiveFeed): Stream.Stream<unknown, Error> {
  const input = record(raw);
  if ((TERMINAL_STREAMS as readonly string[]).includes(tag))
    return terminalStream(tag, input, terminalDeps());
  if (tag === "scheduledTasks.subscribe")
    return Stream.concat(Stream.succeed({ tasks: [] }), Stream.never);
  if (tag === "subscribeServerConfig")
    return Stream.concat(
      Stream.succeed({ version: 1, type: "snapshot", config: serverConfig() }),
      Stream.never,
    );
  if (tag === "subscribeAuthAccess")
    return Stream.concat(
      Stream.succeed({
        version: 1,
        revision: 0,
        type: "snapshot",
        payload: { pairingLinks: [], clientSessions: [] },
      }),
      Stream.never,
    );
  if (tag === "subscribeServerLifecycle")
    return Stream.concat(
      Stream.make(
        decode(C.ServerLifecycleStreamEvent, {
          version: 1,
          sequence: 0,
          type: "welcome",
          payload: {
            environment: descriptor,
            cwd: "/workspace",
            projectName: "Sandbox conversations",
            bootstrapStatus: "complete",
            bootstrapProjectId: "owned-project",
            bootstrapProjectCreated: false,
            bootstrapThreadCreated: false,
          },
        }),
        decode(C.ServerLifecycleStreamEvent, {
          version: 1,
          sequence: 1,
          type: "ready",
          payload: { at: new Date().toISOString(), environment: descriptor },
        }),
      ),
      Stream.never,
    );
  if (
    ![
      "orchestration.subscribeShell",
      "orchestration.subscribeThread",
      "orchestration.subscribeArchivedShell",
    ].includes(tag)
  )
    return Stream.fail(new Error(`Owned adapter denies unsupported subscription: ${tag}`));
  const live = feed;
  if (!live) return Stream.fail(new Error(`Subscription ${tag} needs a live session`));
  return Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let chain = Promise.resolve();
        const refresh = async () => {
          const a = owned();
          if (tag === "orchestration.subscribeThread") {
            const c = await a.snapshot(input.threadId);
            noticeRejectedSteers(c);
            syncOutcomeNotice(c, resolveOutcome);
            syncWorkspaceNotice(c);
            void syncPreviewChip(c, a);
            Queue.offerUnsafe(queue, {
              kind: "snapshot",
              snapshotSequence: c.events.at(-1)?.seq ?? 0,
              projection: projection(c),
            });
          } else {
            const s = shell(await a.list());
            Queue.offerUnsafe(
              queue,
              tag.endsWith("ArchivedShell")
                ? {
                    kind: "snapshot",
                    snapshot: {
                      snapshotSequence: s.snapshotSequence,
                      projects: s.projects,
                      threads: s.archivedThreads,
                    },
                  }
                : { kind: "snapshot", snapshot: s },
            );
          }
          Queue.offerUnsafe(queue, { kind: "synchronized" });
        };
        // Serialize refreshes per subscription; an initial snapshot is taken immediately.
        const receive = () => (chain = chain.then(refresh));
        const unsubscribe = live.subscribe(receive);
        void receive().catch(() => undefined);
        // The session's feed failing ends every subscription; the supervisor reconnects.
        void live.failed.then(() => Queue.endUnsafe(queue));
        return () => {
          unsubscribe();
          // Leaving a thread removes its preview chip (the next thread renders its own).
          if (tag === "orchestration.subscribeThread") clearPreviewChip(String(input.threadId));
        };
      }),
      (unsubscribe) => Effect.sync(() => void unsubscribe()),
    ).pipe(Effect.asVoid),
  );
}
export const layer = (_options?: unknown) =>
  Layer.succeed(RpcSessionFactory, {
    connect: () =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await owned().session();
            configureHarness(await (await request("/health")).json());
            const config = serverConfig();
            // One supervised live feed per session; its failure is the session's end.
            const feed = createFeed().start();
            const client = new Proxy(
              {},
              {
                get: (_target, key) => {
                  const tag = String(key);
                  if (
                    tag.includes("subscribe") ||
                    tag === "terminal.attach" ||
                    tag === "terminal.observe"
                  )
                    return (input: unknown) => subscription(tag, input, feed);
                  return (input: unknown) =>
                    Effect.tryPromise({
                      try: async () => {
                        const rpc = C.WsRpcGroup.requests.get(tag);
                        if (!rpc || !Schema.is(rpc.payloadSchema)(input))
                          throw new Error(`Invalid T3 adapter input: ${tag}`);
                        const value = await invoke(tag, input);
                        if (!Schema.is(rpc.successSchema)(value))
                          throw new Error(`Invalid T3 adapter result: ${tag}`);
                        return value;
                      },
                      catch: (e) =>
                        new ConnectionTransientError({ reason: "transport", detail: String(e) }),
                    });
                },
              },
            ) as WsRpcProtocolClient;
            const session = {
              client,
              initialConfig: Effect.succeed(config),
              subscribeServerConfig: (input: unknown) =>
                subscription("subscribeServerConfig", input, feed),
              ready: Effect.void,
              probe: Effect.tryPromise({
                try: () =>
                  owned()
                    .session()
                    .then(() => undefined),
                catch: connectionError,
              }),
              // Finite and observable: fails once the feed gives up or credentials are rejected.
              closed: Effect.flatMap(
                Effect.promise(() => feed.failed),
                (failure) => Effect.fail(feedFailureError(failure)),
              ),
            } as unknown as RpcSession;
            return { session, feed };
          },
          catch: connectionError,
        }),
        ({ feed }) => Effect.sync(() => feed.close()),
      ).pipe(Effect.map(({ session }) => session)),
  });
export function installHttpAdapter() {
  globalThis.fetch = async (value, init) => {
    const url = new URL(value instanceof Request ? value.url : String(value), location.origin);
    if (url.origin !== location.origin) throw new Error("Unapproved browser destination");
    const response = (data: unknown) =>
      new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/.well-known/t3/environment") return response(descriptor);
    // Upstream exports browser traces to its server; the owned backend keeps none, so
    // they are dropped here instead of becoming 404s.
    if (url.pathname === "/api/observability/v1/traces") return new Response(null, { status: 204 });
    if (url.pathname === "/api/auth/session") {
      await owned().session();
      return response({
        authenticated: true,
        auth,
        scopes,
        permissions: scopes,
        sessionMethod: "bearer-access-token",
      });
    }
    if (url.pathname === "/api/projects")
      return response({
        projects: wire(C.OrchestrationV2ShellSnapshot, shell(await owned().list())).projects,
      });
    if (url.pathname === "/api/orchestration/shell")
      return response(wire(C.OrchestrationV2ShellSnapshot, shell(await owned().list())));
    const match = url.pathname.match(
      /^\/api\/orchestration\/threads\/([^/]+)(?:\/(bounded|history))?$/,
    );
    if (match) {
      const c = await owned().snapshot(match[1]!),
        p = wire(C.OrchestrationV2ThreadProjection, projection(c)),
        sequence = c.events.at(-1)?.seq ?? 0;
      return response(
        match[2] === "history"
          ? { items: p.visibleTurnItems, nextCursor: null, hasMoreHistory: false }
          : {
              snapshotSequence: sequence,
              projection: p,
              historyCursor: null,
              hasMoreHistory: false,
              latestLocalTurnOrdinal: p.turnItems.length,
            },
      );
    }
    return originalFetch(value, init);
  };
}
