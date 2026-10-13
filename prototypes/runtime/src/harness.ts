import { importLegacyPiState } from "./pi-state.ts";
import { assertFence, read, type Fence } from "./store.ts";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { sandboxTools } from "./pi-tools.ts";
import { sandboxSystemPrompt } from "./sandbox-prompt.ts";

const SANDBOX_CWD = "/workspace";
import type { SandboxBroker, ToolCall } from "./sandbox.ts";

export type Sink = (type: string, data: Record<string, unknown>) => Promise<void>;
export interface Harness {
  run(text: string, history: string, emit: Sink, signal: AbortSignal): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}
export type HarnessFactory = (
  owner: string,
  id: string,
  jobId: string,
  fence?: Fence,
) => Promise<Harness>;

export class FixtureHarness implements Harness {
  private release?: () => void;
  private sink?: Sink;
  constructor(
    private broker: SandboxBroker,
    private owner: string,
    private id: string,
    private jobId = "fixture",
    private fence?: Fence,
  ) {}
  async run(text: string, _history: string, emit: Sink, signal: AbortSignal) {
    this.sink = emit;
    signal.throwIfAborted();
    if (text === "/fixture wait") {
      const waiting = new Promise<void>((resolve, reject) => {
        this.release = resolve;
        const abort = () => reject(new Error("Cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      await emit("fixture.waiting", {});
      await waiting;
    }
    signal.throwIfAborted();
    let output = `Deterministic fixture: ${text}`;
    let call: ToolCall | undefined;
    if (text.startsWith("/fixture write ")) {
      const [path, ...content] = text.slice(15).split(" ");
      call = { id: "", tool: "write", args: { path, content: content.join(" ") } };
    } else if (text.startsWith("/fixture read "))
      call = { id: "", tool: "read", args: { path: text.slice(14) } };
    else if (text.startsWith("/fixture bash "))
      call = { id: "", tool: "bash", args: { command: text.slice(14) } };
    if (call) {
      // Engine supplies the job ID in the closure, giving deterministic call IDs.
      call.id = `${this.jobId}:tool:0`;
      await emit("tool.started", { tool: call.tool, callId: call.id, args: call.args });
      const result = await this.broker.execute(this.owner, this.id, call, signal, this.fence);
      output = result.text;
      await emit("tool.output", {
        callId: call.id,
        tool: call.tool,
        args: call.args,
        text: result.text,
        productionData: result.productionData === true,
      });
    }
    for (const delta of [
      output.slice(0, Math.ceil(output.length / 2)),
      output.slice(Math.ceil(output.length / 2)),
    ]) {
      signal.throwIfAborted();
      await emit("assistant.delta", { text: delta });
    }
  }
  async steer(text: string) {
    if (this.sink) await this.sink("assistant.delta", { text: `Steering received: ${text}\n` });
    this.release?.();
  }
  async abort() {
    this.release?.();
  }
  dispose() {
    this.release = undefined;
    this.sink = undefined;
  }
}

export class PiHarness implements Harness {
  constructor(
    private session: AgentSession,
    private persist: () => Promise<void> = async () => {},
    private onDispose: () => void = () => {},
  ) {}
  static async create(
    broker: SandboxBroker,
    owner: string,
    id: string,
    hostDir: string,
    jobId = "sdk",
    fence?: Fence,
    systemPrompt = sandboxSystemPrompt([]),
    /** Per-user overrides (users.ts effectiveModel: already checked against the allowed list). */
    overrides: { model?: string; thinkingLevel?: string } = {},
  ) {
    const cwd = resolve(hostDir),
      agentDir = resolve(cwd, "pi-config");
    await mkdir(agentDir, { recursive: true });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      disabledBuiltinExtensions: ["mcp", "codemode", "web", "browser"],
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: resolve(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const model = modelRuntime.getModel(
      process.env.PI_PROVIDER ?? "anthropic",
      overrides.model ?? process.env.PI_MODEL ?? "claude-sonnet-4-5",
    );
    if (!model) throw new Error("Configured Pi model was not found; set PI_PROVIDER and PI_MODEL");
    await broker.store.mutate(
      owner,
      id,
      (c) => {
        assertFence(c, fence);
        importLegacyPiState(c, jobId);
      },
      { events: true },
    );
    const prior = await read(broker.store, owner, id);
    // The model's working directory is the sandbox's /workspace; the host directory only holds
    // Pi's own config and never appears in the prompt.
    const sessionManager = SessionManager.inMemory(SANDBOX_CWD, undefined, prior.piEntries);
    sessionManager.appendCustomEntry("owned.turn_started", { jobId });
    // Once disposed (including a run abandoned after Stop), this session must never overwrite
    // the conversation's Pi state again: a later turn owns it.
    let disposed = false;
    const persist = async () => {
      if (disposed) return;
      await broker.store.mutate(owner, id, (c) => {
        assertFence(c, fence);
        c.piEntries = structuredClone([
          sessionManager.getHeader()!,
          ...sessionManager.getEntries(),
        ]);
      });
    };
    const { session } = await createAgentSession({
      cwd: SANDBOX_CWD,
      agentDir,
      model,
      modelRuntime,
      ...((overrides.thinkingLevel ?? process.env.PI_THINKING_LEVEL)
        ? {
            thinkingLevel: (overrides.thinkingLevel ?? process.env.PI_THINKING_LEVEL) as
              | "low"
              | "medium"
              | "high",
          }
        : {}),
      settingsManager,
      resourceLoader: loader,
      sessionManager,
      noTools: "builtin",
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "share_port", "unshare_port"],
      customTools: sandboxTools(async (call, signal) => {
        signal?.throwIfAborted();
        // Persist the assistant/tool-call linkage before executing any side effect.
        await persist();
        signal?.throwIfAborted();
        return broker.execute(owner, id, { ...call, id: `${jobId}:${call.id}` }, signal, fence);
      }),
    });
    await persist();
    return new PiHarness(session, persist, () => {
      disposed = true;
    });
  }
  async run(text: string, history: string, emit: Sink, signal: AbortSignal) {
    let chain = Promise.resolve();
    // A model-side failure (API error, refusal) ends the turn with an assistant message whose
    // stopReason is "error" or "refusal" and usually no text. Surface it instead of a blank reply.
    let textSinceMessageStart = false;
    const unsubscribe = this.session.subscribe((event) => {
      const e = event as unknown as Record<string, unknown>;
      if (e.type === "message_start") textSinceMessageStart = false;
      if (e.type === "message_end") {
        const m = e.message as
          | { role?: string; stopReason?: string; errorMessage?: string }
          | undefined;
        if (m?.role === "assistant" && (m.stopReason === "error" || m.stopReason === "refusal")) {
          const detail = (m.errorMessage ?? "").trim() || `stop reason: ${m.stopReason}`;
          const text = `${textSinceMessageStart ? "\n\n" : ""}⚠️ Model request failed: ${detail.slice(0, 1000)}`;
          chain = chain
            .then(() =>
              emit("assistant.error", { stopReason: m.stopReason, message: detail.slice(0, 1000) }),
            )
            .then(() => emit("assistant.delta", { text }));
        }
      }
      if (e.type === "message_end" || e.type === "turn_end")
        chain = chain.then(() => this.persist());
      const next = (type: string, data: Record<string, unknown>) => {
        chain = chain.then(() => emit(type, data));
      };
      if (e.type === "message_update") {
        const a = e.assistantMessageEvent as Record<string, unknown> | undefined;
        if (a?.type === "text_delta" && typeof a.delta === "string") {
          textSinceMessageStart = true;
          next("assistant.delta", { text: a.delta });
        }
      }
      if (e.type === "tool_execution_start")
        next("tool.started", { tool: e.toolName, callId: e.toolCallId, args: e.args });
      if (e.type === "tool_execution_end") {
        const result = e.result as
          | {
              content?: Array<{ type: string; text?: string }>;
              details?: { productionData?: boolean };
            }
          | undefined;
        next("tool.output", {
          tool: e.toolName,
          callId: e.toolCallId,
          text: result?.content?.map((c) => c.text ?? "").join("\n") ?? "",
          isError: e.isError,
          productionData: result?.details?.productionData === true,
        });
      }
    });
    const abort = () => {
      void this.session.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await this.session.prompt(text, { expandPromptTemplates: false });
      await chain;
      signal.throwIfAborted();
    } finally {
      await chain;
      await this.persist();
      signal.removeEventListener("abort", abort);
      unsubscribe();
    }
  }
  async steer(text: string) {
    await this.session.steer(text);
  }
  async abort() {
    await this.session.abort();
  }
  dispose() {
    this.onDispose();
    this.session.dispose();
  }
}
