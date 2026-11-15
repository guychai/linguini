/**
 * Pi Durable harness (D16, milestone V1.1.5).
 *
 * Runs a turn on `@earendil-works/pi-durable` behind the engine's `Harness` interface. The engine
 * keeps owning leases, the job queue, Stop/steer and the tool ledger; Durable owns the model loop
 * and the transcript, which it checkpoints in a per-conversation SQLite file.
 *
 * Security rules (spec D16):
 * - Tools are Linguini's sandbox tools and registered host tools, nothing else. Durable's built-in
 *   coding tools are never installed and no execution env is given, so the only way to run
 *   anything is the Kata sandbox through `SandboxBroker`.
 * - A `beforeTool` hook runs `SandboxBroker.preflight` (ledger block, egress after taint,
 *   host-tool destinations and the sensitive boundary) for EVERY tool task: model calls, code
 *   mode's nested calls and `executeTool()`. Unknown tools (anything Durable might add) are
 *   refused there. The broker checks again when the tool body runs.
 * - The sensitive flag is set by the broker while a call runs (before its result is returned), so
 *   a nested call that reads a sensitive source flags the thread even if the script drops the
 *   data. Nothing in Durable can clear it: only the broker writes it.
 * - Only safe reads are `replay: "safe"`. A non-idempotent call cut off by a crash or the restart
 *   limit becomes an unknown outcome in the ledger, which blocks the thread until resolved.
 * - Code mode is off unless its extension is passed in as an orchestrator (own-main:
 *   PI_DURABLE_CODEMODE=1, default off), and then has no `models.*` and no env.
 *
 * Storage: Durable ships no Postgres adapter, so each conversation gets a SQLite file opened with
 * `synchronous = FULL` (Durable's opener defaults to NORMAL, which can lose the last commits on
 * power loss). Threads that started on the Pi coding-agent harness keep using it (`piEntries`);
 * only new threads use Durable. See DESIGN-durable.md.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness as DurableCore,
  hook,
  section,
  ToolTask,
  type Extension,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { Harness, Sink } from "./harness.ts";
import { handsKey } from "./hands.ts";
import { markUnknown, type ToolPolicy } from "./ledger.ts";
import { TOOL_DESCRIPTIONS, toolSchemas } from "./pi-tools.ts";
import type { SandboxBroker, ToolResult } from "./sandbox.ts";
import { assertFence, type Conversation, type Fence } from "./store.ts";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const ctx: Context = BACKGROUND_CONTEXT;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Diagnostic codes Durable gives a tool task that was cut off rather than finished. */
const CUT_OFF = new Set(["interrupted", "restart_limit", "abandoned"]);
/** The broker call ID of a Durable tool call. Durable's call IDs are stable across restarts and
 * unique in a conversation, so a re-delivered call finds its ledger entry instead of running
 * again. */
export const durableCallId = (callId: string) => `durable:${callId}`;

/** One SQLite file per conversation under `dir`, named by the conversation's hands key. */
export class DurableStore {
  private closing = new Map<string, Promise<void>>();
  constructor(readonly dir: string) {}
  path(owner: string, id: string) {
    return join(this.dir, `${handsKey(owner, id)}.sqlite`);
  }
  async open(owner: string, id: string) {
    const path = this.path(owner, id);
    // A previous turn's harness in this process may still be closing the same file.
    await this.closing.get(path);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const db = await openNodeSqliteDatabase(path);
    try {
      await db.exec("PRAGMA synchronous = FULL");
      const row = await db.get<{ synchronous: number }>("PRAGMA synchronous");
      if (row?.synchronous !== 2) throw new Error("SQLite refused synchronous = FULL");
      const storage = await SqliteStorage.open(db);
      return {
        storage,
        /** Registers the close so a later open of the same file waits for it. */
        track: (closing: Promise<void>) => {
          const done = closing.finally(() => {
            if (this.closing.get(path) === done) this.closing.delete(path);
          });
          this.closing.set(path, done);
          return done;
        },
      };
    } catch (error) {
      await db.close().catch(() => undefined);
      throw error;
    }
  }
  /** Conversation deletion: the transcript file and SQLite's side files. Idempotent. */
  async remove(owner: string, id: string) {
    const path = this.path(owner, id);
    await this.closing.get(path);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(path + suffix, { force: true });
  }
}

export interface DurableHarnessOptions {
  broker: SandboxBroker;
  owner: string;
  id: string;
  jobId: string;
  fence?: Fence;
  store: DurableStore;
  models: Models;
  model: { provider: string; modelId: string };
  thinkingLevel?: string;
  systemPrompt: string;
  /**
   * Extensions whose named tools only orchestrate other tools (code mode). Those tools skip the
   * broker preflight; every tool they call comes back through `beforeTool` as its own task.
   * Empty (the default) keeps code mode off.
   */
  orchestrators?: Array<{ extension: Extension; tools: string[] }>;
  /** Retry policy override (tests). */
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number };
}

type Slot = { emitted: number };

export class DurableHarness implements Harness {
  private sink?: Sink;
  private chain = Promise.resolve();
  private closed?: Promise<void>;
  private constructor(
    private readonly core: DurableCore,
    private readonly root: Awaited<ReturnType<DurableCore["root"]>>,
    private readonly o: DurableHarnessOptions,
    private readonly track: (closing: Promise<void>) => Promise<void>,
    private readonly wire: (h: DurableHarness) => void,
  ) {
    wire(this);
  }

  static async create(o: DurableHarnessOptions): Promise<DurableHarness> {
    const { broker, owner, id, fence } = o;
    // The thread is Durable from its first Durable turn on (never back to piEntries).
    await broker.store.mutate(owner, id, (c) => {
      assertFence(c, fence);
      c.harness = "durable";
    });
    let self: DurableHarness | undefined;
    const emit = (type: string, data: Record<string, unknown>) => self?.queue(type, data);
    // Calls whose body ran in this process. An "aborted" result for any other call is a run
    // left over from a lost worker, ended by the abort in create().
    const ran = new Set<string>();
    const tools = sandboxToolRegistrations(broker, o, emit, ran);
    const orchestrating = new Set((o.orchestrators ?? []).flatMap((x) => x.tools));
    const extension = defineExtension({
      name: "linguini",
      tools,
      sections: [section("linguini", () => o.systemPrompt)],
      hooks: [
        hook(ToolTask, {
          async beforeTool(call) {
            const args = (call.arguments ?? {}) as Record<string, unknown>;
            // Code mode's own tool only orchestrates; each nested call it makes comes back
            // through this hook as its own tool task.
            if (orchestrating.has(call.name) && !call.parent) return;
            try {
              await broker.preflight(owner, id, call.name, args);
            } catch (error) {
              emit("tool.blocked", {
                tool: call.name,
                callId: call.id,
                ...(call.parent ? { parentCallId: call.parent.callId } : {}),
                message: why(error),
              });
              return { block: why(error) };
            }
          },
          async afterTool(call, result) {
            const cutOff = result.diagnostics?.find(
              (d) => d.code && (CUT_OFF.has(d.code) || (d.code === "aborted" && !ran.has(call.id))),
            );
            const policy: ToolPolicy | undefined = broker.policies[call.name];
            if (!cutOff || !policy || policy.replay === "safe-read") return;
            // A call that may have run but has no observation: same rule as a lost worker.
            const callId = durableCallId(call.id);
            let marked = false;
            await broker.store.mutate(owner, id, (c) => {
              for (const e of Object.values(c.ledger ?? {}))
                if (e.status === "intent" && e.callId === callId) {
                  markUnknown(c, e, `Durable ${cutOff.code}: it may or may not have taken effect`);
                  marked = true;
                }
            });
            if (!marked) return;
            return {
              ...result,
              isError: true,
              output: [
                {
                  type: "text",
                  text: `Tool outcome unknown (${cutOff.code}); it was not replayed. The conversation is blocked until the outcome is resolved.`,
                },
              ],
            } satisfies ToolExecutionResult;
          },
        }),
      ],
    });
    const extensions = [extension, ...(o.orchestrators ?? []).map((x) => x.extension)];
    const registry = createRegistry();
    for (const e of extensions) registry.install(e);
    const { storage, track } = await o.store.open(owner, id);
    let core: DurableCore;
    try {
      core = await DurableCore.open(
        storage,
        {
          models: o.models,
          registry,
          settings: {
            extensions,
            toolExecution: "sequential",
            ...(o.retry ? { retry: o.retry } : {}),
          },
          // No `env`: Durable's file and shell tools have nowhere to run. No telemetry.
        },
        ctx,
      );
    } catch (error) {
      await storage.close(ctx).catch(() => undefined);
      throw error;
    }
    try {
      const agent = {
        model: o.model,
        ...(o.thinkingLevel ? { thinkingLevel: o.thinkingLevel as "low" } : {}),
      };
      const root = await core.root(ctx, { agent });
      await root.configure(agent, ctx);
      // The engine never resumes an interrupted turn (it marks it interrupted and the ledger
      // decides what happened to its tools), so a run left over from a lost worker is ended
      // here rather than continued.
      await root.abort(ctx);
      return new DurableHarness(core, root, o, track, (h) => (self = h));
    } catch (error) {
      await core.close(ctx).catch(() => undefined);
      throw error;
    }
  }

  private queue(type: string, data: Record<string, unknown>) {
    const sink = this.sink;
    if (!sink) return this.chain;
    this.chain = this.chain.then(() => sink(type, data)).catch(() => undefined);
    return this.chain;
  }

  async run(text: string, _history: string, emit: Sink, signal: AbortSignal) {
    this.sink = emit;
    signal.throwIfAborted();
    const onAbort = () => void this.root.abort(ctx).catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    // Assistant text: streamed from the live partial, completed from committed entries.
    const slots = new Map<number, Slot>();
    let partial: Slot = { emitted: 0 };
    let first = Number.POSITIVE_INFINITY;
    let wrote = false;
    const write = (delta: string) => {
      if (!delta) return;
      wrote = true;
      void this.queue("assistant.delta", { text: delta });
    };
    const textOf = (content: unknown) =>
      Array.isArray(content)
        ? content
            .filter((b) => b && b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("")
        : "";
    const absorb = (entries: readonly any[], live: any) => {
      for (const e of [...entries].sort((a, b) => a.id - b.id)) {
        if (e.kind !== "pi.assistant" || e.id <= first || slots.has(e.id)) continue;
        const message = e.model?.[0];
        const full = textOf(message?.content);
        const slot = { emitted: Math.min(partial.emitted, full.length) };
        partial = { emitted: 0 };
        slots.set(e.id, slot);
        if (full && wrote && slot.emitted === 0) write("\n\n");
        write(full.slice(slot.emitted));
        slot.emitted = full.length;
      }
      const p = textOf(live?.generation?.partial?.content);
      if (p.length > partial.emitted) {
        if (partial.emitted === 0 && wrote) write("\n\n");
        write(p.slice(partial.emitted));
        partial.emitted = p.length;
      }
    };
    const watch = await this.root.watch(ctx);
    watch.start(async (call) => {
      if (call.kind === "value") absorb(call.value.entries, call.value.docs["pi.live"]);
    });
    try {
      const submission = await this.root.submit(
        { type: "input", content: text, requestId: this.o.jobId },
        ctx,
      );
      const settled = await submission.wait(ctx);
      first = settled.entry ?? first;
      await watch.stop();
      // Final pass over the run's entries: whatever the throttled watch did not deliver.
      const page = await this.root.entries(
        { minEntryId: settled.entry, order: "ascending" },
        500,
        undefined,
        ctx,
      );
      absorb(page.items, undefined);
      if (settled.status !== "done" && !signal.aborted) {
        const view = watch.value;
        const failure = (view?.docs["pi.live"] as any)?.runFailure;
        const detail = String(failure?.detail ?? failure?.reason ?? "no answer").slice(0, 1000);
        void this.queue("assistant.error", { stopReason: failure?.reason, message: detail });
        write(`${wrote ? "\n\n" : ""}⚠️ Model request failed: ${detail}`);
      }
      await this.chain;
      signal.throwIfAborted();
    } finally {
      await watch.stop().catch(() => undefined);
      await this.chain;
      signal.removeEventListener("abort", onAbort);
    }
  }

  async steer(text: string) {
    await this.root.submit({ type: "input", content: text, whenBusy: "steer" }, ctx);
  }

  async abort() {
    await this.root.abort(ctx);
  }

  dispose() {
    if (this.closed) return;
    this.sink = undefined;
    this.closed = this.track(this.core.close(ctx).catch(() => undefined));
  }
}

/** Linguini's sandbox and host tools as Durable tools: every body is `SandboxBroker.execute`. */
function sandboxToolRegistrations(
  broker: SandboxBroker,
  o: Pick<DurableHarnessOptions, "owner" | "id" | "fence">,
  emit: (type: string, data: Record<string, unknown>) => void,
  ran: Set<string>,
): ToolRegistration[] {
  const schemas = toolSchemas() as Record<string, object>;
  const describe = (name: string) => {
    const host = broker.hostTools?.get(name);
    if (host?.parameters && host.description)
      return { description: host.description, parameters: host.parameters };
    if (Object.hasOwn(schemas, name))
      return {
        description: TOOL_DESCRIPTIONS[name as keyof typeof TOOL_DESCRIPTIONS],
        parameters: schemas[name]!,
      };
    return undefined;
  };
  return Object.keys(broker.policies)
    .filter((name) => describe(name) !== undefined)
    .map((name) =>
      defineTool({
        name,
        description: describe(name)!.description,
        parameters: describe(name)!.parameters as never,
        // Only safe reads may be re-run by Durable after a crash; everything else is the
        // ledger's call (intent/unknown), never a blind replay.
        replay: broker.policies[name]!.replay === "safe-read" ? "safe" : "unsafe",
        callers: ["model", "tools"],
        async execute(args, api, context) {
          ran.add(api.callId);
          const call = {
            id: durableCallId(api.callId),
            tool: name,
            args: args as Record<string, unknown>,
          };
          emit("tool.started", { tool: name, callId: api.callId, args: call.args });
          let result: ToolResult;
          try {
            result = await broker.execute(o.owner, o.id, call, context.abortSignal, o.fence);
          } catch (error) {
            emit("tool.output", {
              tool: name,
              callId: api.callId,
              text: why(error),
              isError: true,
            });
            throw error;
          }
          emit("tool.output", {
            tool: name,
            callId: api.callId,
            args: call.args,
            text: result.text,
            productionData: result.productionData === true,
          });
          return {
            output: [
              { type: "text" as const, text: result.text },
              ...(result.images ?? []).map((image) => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            ],
            details: { sandbox: true, productionData: result.productionData === true },
          };
        },
      }),
    );
}

export type HarnessMode = "fixture" | "pi" | "durable";
/**
 * Which harness runs this turn. A Durable thread stays Durable. With HARNESS_MODE=durable, a
 * thread with no earlier turn (and no Pi transcript) starts on Durable; threads that began on the
 * Pi coding-agent harness keep it, so their `piEntries` are never migrated or dropped.
 */
export function chooseHarness(c: Conversation, jobId: string, mode: HarnessMode): HarnessMode {
  if (c.harness === "durable") return "durable";
  if (mode !== "durable") return mode;
  const earlier =
    c.piEntries?.length || c.jobs.some((j) => j.id !== jobId && j.status !== "queued");
  return earlier ? "pi" : "durable";
}

/**
 * The host's Pi credentials file (`auth.json`: provider -> credential, the format the Pi harness
 * reads) as pi-ai's CredentialStore. Writes (OAuth refresh) replace the file atomically, 0600.
 */
export class FileCredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async all(): Promise<Record<string, any>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Pi credentials file is unreadable");
    }
  }
  private async save(all: Record<string, unknown>) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
  async read(providerId: string) {
    return (await this.all())[providerId];
  }
  async list() {
    return Object.entries(await this.all()).map(([providerId, c]) => ({
      providerId,
      type: c?.type,
    })) as never;
  }
  modify(providerId: string, fn: (current: any) => Promise<any>) {
    const run = this.chain.then(async () => {
      const all = await this.all();
      const next = await fn(all[providerId]);
      if (next === undefined) delete all[providerId];
      else all[providerId] = next;
      await this.save(all);
      return next;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
  async delete(providerId: string) {
    await this.modify(providerId, async () => undefined);
  }
}

/** The models Durable calls: pi-ai's built-in providers with the host's Pi credentials. */
export function durableModels(authPath: string): Models {
  return builtinModels({ credentials: new FileCredentialStore(authPath) as never });
}

/**
 * Durable code mode as an orchestrator (own-main: PI_DURABLE_CODEMODE=1, default off). Scripts run
 * in QuickJS on a worker thread with no Node globals, file system, network or timers, and get no
 * `models.*`; every `tools.<name>()` call is its own tool task, so it passes `beforeTool` and the
 * broker like a model call. Nothing secret is handed to the sandbox: it has no options for env.
 */
export function durableCodemode(): { extension: Extension; tools: string[] } {
  return {
    extension: createCodemodeExtension({ sandbox: new CodemodeSandbox(), models: false }),
    tools: [CODEMODE_TOOL_NAME],
  };
}
