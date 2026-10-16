import { digestSha256 } from "./insecure-context.ts";
import { ledgerStates } from "./outcome-notice.ts";
import * as C from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../../../packages/shared/src/keybindings.ts";
import * as Schema from "effect/Schema";
import type { Conversation, Job } from "./adapter.ts";
let harnessLabel = "Pi (deterministic fixture)";
export function configureHarness(info: { harness?: string; model?: string }) {
  if (info.harness === "pi") {
    MODEL.model = info.model ?? "claude-sonnet-4-5";
    harnessLabel = "Pi (host SDK, live calls unverified)";
  }
}
export const MODEL = { instanceId: "pi", model: "fixture" };
const DATE = "2026-10-09T00:00:00.000Z";
export function decode<S extends Schema.Codec<any, any, never, never>>(
  schema: S,
  value: unknown,
): S["Type"] {
  return Schema.decodeUnknownSync(Schema.toCodecJson(schema))(value);
}
export const descriptor = {
  environmentId: "local",
  label: "Owned Pi / Postgres",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.14",
  orchestrationProtocolVersion: 2,
  capabilities: {
    terminal: true,
    git: false,
    worktrees: false,
    agentActivityPublishing: false,
    threadPinning: true,
    threadPinReorder: true,
    threadActiveReorder: true,
    threadSettlement: true,
  },
};
export async function configureOwner(owner: string) {
  const hash = await digestSha256(new TextEncoder().encode(owner));
  descriptor.environmentId =
    "owned-" +
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 24);
  descriptor.label = `Owned Pi / Postgres (${owner})`;
}
export const auth = {
  policy: "remote-reachable",
  bootstrapMethods: [],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "owned-unused",
};
// terminal:read is not a legacy scope, so T3 no longer shows its "Permissions have changed" notice.
export const scopes = [
  "orchestration:read",
  "orchestration:operate",
  "terminal:read",
  "terminal:operate",
  // The Files panel (read-only, sandbox /workspace of the open conversation).
  "filesystem:read",
  // Files panel saves (sandbox /workspace only, version-checked).
  "filesystem:write",
];
export function serverConfig() {
  return decode(C.ServerConfig, {
    environment: descriptor,
    auth,
    cwd: "/workspace",
    keybindingsConfigPath: "/disabled",
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    issues: [],
    providers: [
      {
        instanceId: "pi",
        driver: "pi",
        displayName: harnessLabel,
        enabled: true,
        installed: true,
        version: "1.1.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: DATE,
        models: [
          {
            slug: MODEL.model,
            name: MODEL.model === "fixture" ? "Deterministic fixture" : MODEL.model,
            isCustom: true,
            capabilities: null,
          },
        ],
        supportedRuntimeModes: ["full-access"],
        slashCommands: [],
        skills: [],
        nativeSessions: { canList: false, canLoad: false, canResume: false },
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/disabled",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...Schema.encodeSync(C.ServerSettings)(C.DEFAULT_SERVER_SETTINGS),
      providerInstances: { pi: { driver: "pi", enabled: true, config: { enabled: true } } },
      defaultModelSelection: MODEL,
      enableAgentBrowserAccess: false,
      enableAgentDeviceAccess: false,
      enableDeviceSupport: false,
      defaultThreadEnvMode: "local",
      enableProviderUpdateChecks: false,
    },
    shellResumeCompletionMarker: true,
    threadResumeCompletionMarker: true,
  });
}
const TERMINAL = new Set(["done", "cancelled", "interrupted", "rejected"]);
const END_EVENTS = new Set([
  "run.completed",
  "run.interrupted",
  "run.cancelled",
  "steering.accepted",
  "steering.rejected",
]);
/**
 * A turn's real start/end. Persisted job fields first; for turns recorded before those existed,
 * the journal's own timestamps (run.started, run.completed, ...); otherwise null, so the UI shows
 * "Worked" without a made-up duration instead of subtracting two equal times.
 */
export function jobTiming(c: Conversation, job: Job, events = c.events) {
  const mine = events.filter((e) => e.data.jobId === job.id && e.timestamp);
  const ts = (types: string[]) => mine.find((e) => types.includes(e.type))?.timestamp ?? null;
  const requestedAt =
    job.requestedAt ?? ts(["message.user", "run.queued"]) ?? mine[0]?.timestamp ?? null;
  const startedAt = job.status === "queued" ? null : (job.startedAt ?? ts(["run.started"]) ?? null);
  const completedAt = !TERMINAL.has(job.status)
    ? null
    : (job.completedAt ??
      [...mine].reverse().find((e) => END_EVENTS.has(e.type))?.timestamp ??
      (startedAt ? (mine.at(-1)?.timestamp ?? null) : null));
  const lastActivity = mine.at(-1)?.timestamp ?? null;
  return { requestedAt, startedAt, completedAt, lastActivity };
}
export function projection(c: Conversation) {
  const date = c.createdAt ?? DATE,
    updated = c.updatedAt ?? date;
  const thread = {
    createdBy: "user",
    creationSource: "web",
    id: c.id,
    projectId: "owned-project",
    title: c.tainted ? `${c.title} · Sensitive data: exports blocked` : c.title,
    providerInstanceId: "pi",
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: c.id },
    forkedFrom: null,
    createdAt: date,
    updatedAt: updated,
    archivedAt: c.metadata?.archivedAt ?? null,
    settledOverride: c.metadata?.settledOverride ?? null,
    settledAt: c.metadata?.settledAt ?? null,
    unsettledAt: c.metadata?.unsettledAt ?? null,
    lastVisitedAt: c.metadata?.lastVisitedAt ?? null,
    pinnedAt: c.metadata?.pinnedAt ?? null,
    pinOrderKey: c.metadata?.pinOrderKey ?? null,
    activeOrderKey: c.metadata?.activeOrderKey ?? null,
    deletedAt: null,
  };
  const timing = new Map(c.jobs.map((j) => [j.id, jobTiming(c, j)]));
  const runs = c.jobs.map((j, i) => ({
    id: j.id,
    threadId: c.id,
    ordinal: i + 1,
    providerInstanceId: "pi",
    modelSelection: MODEL,
    providerThreadId: null,
    userMessageId: j.messageId ?? `user-${j.id}`,
    rootNodeId: null,
    activeAttemptId: null,
    status: j.status === "done" ? "completed" : j.status === "rejected" ? "failed" : j.status,
    requestedAt: timing.get(j.id)!.requestedAt ?? date,
    startedAt: timing.get(j.id)!.startedAt,
    completedAt: timing.get(j.id)!.completedAt,
    checkpointId: null,
    contextHandoffId: null,
  }));
  const messages: Record<string, unknown>[] = [],
    items: Record<string, unknown>[] = [];
  let ordinal = 0;
  for (const job of c.jobs) {
    const events = c.events.filter((e) => e.data.jobId === job.id),
      text = events
        .filter((e) => e.type === "assistant.delta")
        .map((e) => String(e.data.text))
        .join("");
    const t = timing.get(job.id)!;
    const begun = t.startedAt ?? t.requestedAt ?? date;
    const ended = t.completedAt ?? t.lastActivity ?? begun;
    const base = () => ({
      id: `${job.id}-item-${ordinal}`,
      threadId: c.id,
      runId: job.id,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: ordinal++,
      status:
        job.status === "done"
          ? "completed"
          : job.status === "queued"
            ? "pending"
            : job.status === "running"
              ? "running"
              : job.status === "rejected"
                ? "failed"
                : job.status,
      title: null,
      startedAt: begun,
      completedAt: job.status === "running" ? null : ended,
      updatedAt: ended,
    });
    const message = (role: string, content: string) => ({
      id: role === "user" ? (job.messageId ?? `user-${job.id}`) : `${role}-${job.id}`,
      threadId: c.id,
      runId: job.id,
      nodeId: null,
      role,
      text: content,
      attachments: [],
      streaming: role === "assistant" && job.status === "running",
      // User message: when it was sent. Assistant message: from the turn's start to its last output.
      createdAt: role === "user" ? (t.requestedAt ?? date) : begun,
      updatedAt: role === "user" ? (t.requestedAt ?? date) : ended,
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "web",
    });
    messages.push(message("user", job.text));
    items.push({
      ...base(),
      // Upstream records a sent message as completed at once; the run carries the turn's state.
      status: "completed",
      completedAt: t.requestedAt ?? date,
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      messageId: job.messageId ?? `user-${job.id}`,
      inputIntent: job.kind === "steer" ? "steer" : "turn_start",
      text: job.text,
      attachments: [],
    });
    const outputs = events.filter((e) => e.type === "tool.output");
    // Ledger state of each call: an unknown outcome is shown on the call itself.
    const ledger = ledgerStates(c);
    for (const start of events.filter((e) => e.type === "tool.started")) {
      const output = outputs.find((e) =>
        start.data.callId ? e.data.callId === start.data.callId : e.data.tool === start.data.tool,
      );
      const callId = String(start.data.callId ?? "");
      const outcome = ledger.get(callId) ?? ledger.get(`${job.id}:${callId}`);
      items.push({
        ...base(),
        id: `tool-${job.id}-${start.seq}`,
        type: "dynamic_tool",
        toolName: String(start.data.tool),
        input: start.data.args ?? {},
        // The row label carries the ledger state, so it is visible without opening the call.
        ...(!output && outcome?.state === "unknown"
          ? { title: `${String(start.data.tool)}: outcome unknown, conversation blocked` }
          : !output && outcome?.state === "resolved"
            ? {
                title: `${String(start.data.tool)}: outcome marked ${outcome.outcome === "applied" ? "applied" : "not applied"}`,
              }
            : {}),
        output:
          !output && outcome?.state === "unknown"
            ? "Outcome unknown: this call was interrupted and may or may not have taken effect. The conversation is blocked until it is marked applied or not applied."
            : !output && outcome?.state === "resolved"
              ? `Outcome resolved: marked ${outcome.outcome === "applied" ? "applied" : "not applied"}.`
              : (output?.data.text ?? null),
        status: output
          ? output.data.isError
            ? "failed"
            : "completed"
          : job.status === "running"
            ? "running"
            : job.status === "cancelled"
              ? "cancelled"
              : "interrupted",
        startedAt: start.timestamp ?? begun,
        completedAt: output?.timestamp ?? null,
        updatedAt: output?.timestamp ?? start.timestamp ?? ended,
      });
    }
    if (text) {
      messages.push(message("assistant", text));
      items.push({
        ...base(),
        type: "assistant_message",
        messageId: `assistant-${job.id}`,
        text,
        streaming: job.status === "running",
      });
    }
  }
  const visibleTurnItems = items.map((item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: c.id,
    sourceItemId: item.id,
    item,
  }));
  return decode(C.OrchestrationV2ThreadProjection, {
    thread,
    runs,
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages,
    plans: [],
    turnItems: items,
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: updated,
  });
}
export function shell(rows: Conversation[]) {
  const updated = (c: Conversation) => c.updatedAt ?? c.createdAt ?? DATE;
  const threads = rows.map((c) => {
    const p = projection(c),
      active = p.runs.find((r) => r.status === "running"),
      latest = p.runs.at(-1);
    const encoded = Schema.encodeSync(Schema.toCodecJson(C.OrchestrationV2ThreadProjection))(p) as {
      thread: Record<string, unknown>;
    };
    return {
      ...encoded.thread,
      archivedAt: c.metadata?.archivedAt ?? null,
      latestRunId: latest?.id ?? null,
      activeRunId: active?.id ?? null,
      status: active?.status ?? latest?.status ?? "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: p.messages.length
        ? {
            id: p.messages.at(-1)!.id,
            role: p.messages.at(-1)!.role,
            text: p.messages.at(-1)!.text,
            updatedAt: updated(c),
          }
        : null,
      latestUserMessageAt: p.messages.length ? updated(c) : null,
      hasActionableProposedPlan: false,
      itemCount: p.turnItems.length,
      visibleItemCount: p.turnItems.length,
    };
  });
  return decode(C.OrchestrationV2ShellSnapshot, {
    schemaVersion: 2,
    snapshotSequence: rows.reduce((n, c) => n + (c.events.at(-1)?.seq ?? 0), 0),
    projects: [
      {
        id: "owned-project",
        title: "Sandbox conversations",
        workspaceRoot: "/workspace",
        defaultModelSelection: MODEL,
        scripts: [],
        createdAt: DATE,
        updatedAt: DATE,
      },
    ],
    threads: threads.filter((t) => !t.archivedAt),
    archivedThreads: threads.filter((t) => t.archivedAt),
  });
}
