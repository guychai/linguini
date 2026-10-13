import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  DEFAULT_TOOL_POLICIES,
  PUBLICATION_POLICY,
  SAFE_READ_MAX_ATTEMPTS,
  assertEgressAllowed,
  assertNotBlocked,
  executionId,
  ledgerOf,
  markUnknown,
  policyVersion,
  type EgressBoundary,
  type LedgerEntry,
  type ToolPolicies,
  type ToolPolicy,
} from "./ledger.ts";
import {
  ApiError,
  append,
  assertFence,
  read,
  type Conversation,
  StaleOwnerError,
  type Fence,
  type Store,
} from "./store.ts";

export type ToolName =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "grep"
  | "find"
  | "ls"
  | "share_port"
  | "unshare_port";
/** Ledger boundaries, in order. Fault hooks fire at each one (tests kill the process there). */
export type LedgerBoundary =
  | "before-intent"
  | "after-intent"
  | "after-effect"
  | "after-observation";
export interface BrokerOptions {
  /** Declared replay class, destination and egress of every tool. */
  policies?: ToolPolicies;
  /** Test-only fault injection at each ledger boundary. */
  fault?: (
    boundary: LedgerBoundary,
    entry: { execId: string; tool: string },
  ) => void | Promise<void>;
}
export interface ToolCall {
  id: string;
  /** A declared tool: a key of the broker's policy table. */
  tool: ToolName | (string & {});
  args: Record<string, unknown>;
}
export interface ToolResult {
  text: string;
  productionData?: boolean;
}
export interface ExecuteOptions {
  idempotencyKey?: string;
  execId?: string;
  epoch?: number;
  owner?: string;
  conversationId?: string;
  /** The conversation's taint, read after any taint for this call committed. */
  tainted?: boolean;
}
export interface SandboxProvider {
  readonly kind: "deterministic-fixture" | "remote";
  /**
   * "declared": results carry the provenance of the tool's declared destination (a
   * "sandbox" tool is sandbox work, not production data), so no classify preflight runs.
   * Absent: a remote provider without classify is treated as unknown provenance (taints).
   */
  readonly provenanceSource?: "declared";
  /** "proxy": all network egress of this provider's tools goes through the egress proxy. */
  readonly egressBoundary?: EgressBoundary;
  // Allocation must be idempotent for this owner+conversation key.
  allocate(owner: string, conversationId: string): Promise<string>;
  classify?(sandbox: string, call: ToolCall): Promise<"ordinary" | "production" | "unknown">;
  /**
   * `idempotencyKey` is set for calls declared idempotent-write: the destination must apply
   * at most one effect per key and answer a repeat with the original result. `execId` and
   * `epoch` identify the ledger intent and the lease it was written under; `owner` and
   * `conversationId` name the binding (providers must not trust them from anywhere else).
   */
  execute(
    sandbox: string,
    call: ToolCall,
    signal?: AbortSignal,
    options?: ExecuteOptions,
  ): Promise<ToolResult>;
}
export function fingerprint(input: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, value]) => [k, canonical(value)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}
export function assertPublicationAllowed(c: Conversation) {
  assertEgressAllowed(c, PUBLICATION_POLICY, "publication");
}
/** A path inside /workspace, normalized and relative. Rejects traversal and absolute escapes. */
export function sandboxPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.split("/").some((p) => ["..", "__proto__", "constructor", "prototype"].includes(p))
  )
    throw new ApiError(400, "Invalid sandbox path");
  const p = posix.normalize(value.startsWith("/workspace/") ? value.slice(11) : value);
  if (p.startsWith("/") || p === ".." || p.startsWith("../"))
    throw new ApiError(400, "Path outside sandbox");
  return p;
}
export function fixtureExecute(c: Conversation, call: ToolCall): ToolResult {
  const args = call.args;
  switch (call.tool) {
    case "read": {
      const content = c.files[sandboxPath(args.path)];
      if (content === undefined) throw new ApiError(404, "Sandbox file not found");
      const lines = content.split("\n");
      const start = typeof args.offset === "number" ? Math.max(0, args.offset - 1) : 0;
      return {
        text: lines
          .slice(start, typeof args.limit === "number" ? start + args.limit : undefined)
          .join("\n"),
      };
    }
    case "write": {
      if (typeof args.content !== "string") throw new ApiError(400, "content must be a string");
      c.files[sandboxPath(args.path)] = args.content;
      return { text: "File written in deterministic fixture" };
    }
    case "edit": {
      const p = sandboxPath(args.path),
        content = c.files[p];
      if (
        content === undefined ||
        typeof args.oldText !== "string" ||
        !args.oldText ||
        typeof args.newText !== "string" ||
        content.split(args.oldText).length !== 2
      )
        throw new ApiError(409, "Edit must match exactly once");
      c.files[p] = content.replace(args.oldText, args.newText);
      return { text: "File edited in deterministic fixture" };
    }
    case "bash": {
      // Never run a host shell in fixture mode. This is a protocol fixture, not isolation.
      if (args.command === "pwd") return { text: "/workspace\n" };
      if (args.command === "ls") return { text: Object.keys(c.files).sort().join("\n") };
      if (args.command === "fixture:production-read")
        return { text: "SYNTHETIC production record", productionData: true };
      throw new ApiError(
        501,
        "Fixture supports only pwd, ls and fixture:production-read; no host execution",
      );
    }
    case "ls": {
      const dir = args.path === undefined ? "." : sandboxPath(args.path);
      const prefix = dir === "." ? "" : `${dir}/`;
      const entries = new Set<string>();
      for (const f of Object.keys(c.files))
        if (f.startsWith(prefix)) {
          const [head, ...rest] = f.slice(prefix.length).split("/");
          entries.add(rest.length ? `${head}/` : head!);
        }
      if (!entries.size && dir !== ".") throw new ApiError(404, "Sandbox directory not found");
      return { text: [...entries].sort().slice(0, limitOf(args.limit, 500)).join("\n") };
    }
    case "find": {
      if (typeof args.pattern !== "string" || !args.pattern)
        throw new ApiError(400, "pattern required");
      const dir = args.path === undefined ? "." : sandboxPath(args.path);
      const prefix = dir === "." ? "" : `${dir}/`;
      const match = globMatcher(args.pattern);
      const found = Object.keys(c.files)
        .filter((f) => f.startsWith(prefix) && match(f.slice(prefix.length)))
        .map((f) => f.slice(prefix.length))
        .sort();
      return { text: found.slice(0, limitOf(args.limit, 1000)).join("\n") || "No files found" };
    }
    case "grep": {
      if (typeof args.pattern !== "string" || !args.pattern)
        throw new ApiError(400, "pattern required");
      const dir = args.path === undefined ? "." : sandboxPath(args.path);
      const prefix = dir === "." ? "" : `${dir}/`;
      const source = args.literal
        ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : args.pattern;
      let re: RegExp;
      try {
        re = new RegExp(source, args.ignoreCase ? "i" : "");
      } catch {
        throw new ApiError(400, "Invalid regular expression");
      }
      const glob = typeof args.glob === "string" ? globMatcher(args.glob) : () => true;
      const limit = limitOf(args.limit, 100);
      const out: string[] = [];
      for (const f of Object.keys(c.files).sort()) {
        if (!(f === dir || f.startsWith(prefix)) || !glob(f.slice(prefix.length))) continue;
        c.files[f]!.split("\n").forEach((line, i) => {
          if (out.length < limit && re.test(line)) out.push(`${f}:${i + 1}:${line}`);
        });
      }
      return { text: out.join("\n") || "No matches found" };
    }
    default:
      throw new ApiError(403, "Tool unavailable");
  }
}
function limitOf(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
/** Glob as Pi uses it: "*.ts" matches by basename anywhere; patterns with "/" match the path. */
export function globMatcher(glob: string): (relative: string) => boolean {
  const re = new RegExp(
    `^${glob
      .split(/(\*\*\/?|\*|\?)/)
      .map((part) =>
        part === "**/"
          ? "(?:.*/)?"
          : part === "**"
            ? ".*"
            : part === "*"
              ? "[^/]*"
              : part === "?"
                ? "[^/]"
                : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
      )
      .join("")}$`,
  );
  return glob.includes("/") ? (p) => re.test(p) : (p) => re.test(p.split("/").at(-1)!);
}
export class FixtureSandbox implements SandboxProvider {
  readonly kind = "deterministic-fixture";
  allocations = 0;
  async allocate(owner: string, id: string) {
    this.allocations++;
    return `fixture-${fingerprint([owner, id])}`;
  }
  async execute(): Promise<ToolResult> {
    throw new Error("Fixture tools execute transactionally in the durable store");
  }
}
export class RemoteSandbox implements SandboxProvider {
  private provenance = new Map<string, "ordinary" | "production" | "unknown">();
  readonly kind = "remote";
  constructor(
    private endpoint: string,
    private token: string,
  ) {
    if (!endpoint.startsWith("https://")) throw new Error("Remote sandbox requires HTTPS");
  }
  private async request(route: string, body: unknown, signal?: AbortSignal) {
    const response = await fetch(new URL(route, this.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new ApiError(502, `Sandbox service returned ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
  async allocate(owner: string, conversationId: string) {
    const result = await this.request("/allocate", {
      owner,
      conversationId,
      idempotencyKey: fingerprint([owner, conversationId]),
    });
    if (typeof result.sandboxId !== "string")
      throw new ApiError(502, "Invalid allocation response");
    return result.sandboxId;
  }
  async classify(
    sandboxId: string,
    call: ToolCall,
  ): Promise<"ordinary" | "production" | "unknown"> {
    // Trusted service preflight; the agent cannot set provenance. No execution is allowed here.
    const result = await this.request("/classify", { sandboxId, ...call });
    if (!["ordinary", "production", "unknown"].includes(String(result.dataClass)))
      throw new ApiError(502, "Invalid provenance response");
    const classification = result.dataClass as "ordinary" | "production" | "unknown";
    this.provenance.set(fingerprint([sandboxId, call]), classification);
    return classification;
  }
  async execute(
    sandboxId: string,
    call: ToolCall,
    signal?: AbortSignal,
    options: { idempotencyKey?: string } = {},
  ): Promise<ToolResult> {
    const expectedDataClass = this.provenance.get(fingerprint([sandboxId, call])) ?? "unknown";
    const result = await this.request(
      "/execute",
      {
        sandboxId,
        ...call,
        expectedDataClass,
        denyExports: true,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      },
      signal,
    );
    if (typeof result.text !== "string") throw new ApiError(502, "Invalid tool result");
    // Conservative until an audited ingress provenance contract exists: every
    // remote result is tainted. The remote service must also deny export egress.
    return { text: result.text, productionData: result.productionData !== false };
  }
}
export class SandboxBroker {
  private locks = new Map<string, Promise<unknown>>();
  readonly policies: ToolPolicies;
  readonly policyVersion: string;
  private fault: NonNullable<BrokerOptions["fault"]>;
  constructor(
    readonly store: Store,
    readonly provider: SandboxProvider,
    options: BrokerOptions = {},
  ) {
    this.policies = options.policies ?? DEFAULT_TOOL_POLICIES;
    this.policyVersion = policyVersion(this.policies);
    this.fault = options.fault ?? (() => undefined);
  }
  /** Serializes work per conversation in this process; different conversations stay independent. */
  private serial<T>(owner: string, id: string, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([owner, id]);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.locks.set(key, current);
    return current.finally(() => {
      if (this.locks.get(key) === current) this.locks.delete(key);
    });
  }
  async execute(
    owner: string,
    id: string,
    call: ToolCall,
    signal?: AbortSignal,
    fence?: Fence,
  ): Promise<ToolResult> {
    if (
      !call.id ||
      call.id.length > 200 ||
      typeof call.tool !== "string" ||
      !Object.hasOwn(this.policies, call.tool) ||
      !call.args ||
      typeof call.args !== "object" ||
      Array.isArray(call.args)
    )
      throw new ApiError(400, "Invalid tool call");
    return this.serial(owner, id, () => this.executeLocked(owner, id, call, signal, fence));
  }
  /**
   * Recovery after a new lease: re-sends interrupted safe reads (within the bound) and
   * idempotent writes (same key) left by an earlier epoch. Non-idempotent intents were
   * already marked unknown when the lease was taken. Per-call failures are left in place.
   */
  async recover(owner: string, id: string, fence?: Fence) {
    return this.serial(owner, id, async () => {
      const c = await read(this.store, owner, id);
      const recovered: string[] = [];
      for (const e of Object.values(c.ledger ?? {})) {
        if (e.status !== "intent" || (fence && e.epoch >= fence.epoch)) continue;
        try {
          await this.resume(
            owner,
            id,
            { id: e.callId, tool: e.tool, args: e.args },
            e,
            undefined,
            fence,
          );
          recovered.push(e.execId);
        } catch (error) {
          if (error instanceof StaleOwnerError) throw error;
        }
      }
      return recovered;
    });
  }
  private policy(tool: string): ToolPolicy {
    const policy = this.policies[tool];
    if (!policy) throw new ApiError(400, "Invalid tool call");
    return policy;
  }
  private async executeLocked(
    owner: string,
    id: string,
    call: ToolCall,
    signal?: AbortSignal,
    fence?: Fence,
  ): Promise<ToolResult> {
    const policy = this.policy(call.tool);
    const execId = executionId(owner, id, call.id);
    const argsDigest = fingerprint(call.args);
    let c = await read(this.store, owner, id);
    const entry = c.ledger?.[execId];
    if (entry) {
      if (entry.argsDigest !== argsDigest || entry.tool !== call.tool)
        throw new ApiError(409, "Command ID reused with a different payload");
      // A redelivery of a call the ledger already knows: never dispatch it blindly.
      return this.resume(owner, id, call, entry, signal, fence);
    }
    // Rows written before the ledger existed.
    const receiptKey = `tool:${call.id}`;
    const existing = c.receipts[receiptKey];
    if (existing) {
      if (existing.fingerprint !== fingerprint(call))
        throw new ApiError(409, "Command ID reused with a different payload");
      if (existing.result === null)
        throw new ApiError(409, "Tool outcome unknown after restart; automatic replay denied");
      return existing.result as ToolResult;
    }
    if (signal?.aborted) throw new ApiError(409, "Cancelled");
    const boundary = this.provider.egressBoundary ?? "none";
    // Taint commits before dispatch, even for a stale owner: it only ever restricts.
    const taint = async (reason: string) => {
      await this.store.mutate(owner, id, (state) => {
        if (!state.tainted) {
          state.tainted = true;
          append(state, "taint.changed", { tainted: true, reason, callId: call.id });
        }
      });
      c = await read(this.store, owner, id);
    };
    // Every policy decision that needs no sandbox runs before allocation, so a refused call
    // never starts a VM: blocked ledger, egress after taint, and declared provenance.
    assertNotBlocked(c);
    assertEgressAllowed(c, policy, call.tool, boundary);
    const declared = policy.destination === "production" ? "production" : "ordinary";
    const needsClassify =
      declared === "ordinary" &&
      this.provider.kind === "remote" &&
      this.provider.provenanceSource !== "declared";
    if (declared === "production") await taint("production");
    else if (needsClassify && !this.provider.classify) await taint("unknown");
    assertEgressAllowed(c, policy, call.tool, boundary);
    if (c.sandbox === null) {
      const allocated = await this.provider.allocate(owner, id);
      await this.store.mutate(owner, id, (state) => {
        assertFence(state, fence);
        state.sandbox ??= allocated;
        append(state, "sandbox.allocated", { sandboxId: state.sandbox, kind: this.provider.kind });
      });
      c = await read(this.store, owner, id);
    }
    // A trusted service's provenance preflight needs the sandbox, so it runs after allocation.
    if (needsClassify && this.provider.classify) {
      let preflightFailure: unknown;
      const provenance = await this.provider.classify(c.sandbox!, call).catch((error) => {
        preflightFailure = error;
        return "unknown" as const;
      });
      if (provenance !== "ordinary") await taint(provenance);
      if (preflightFailure) throw preflightFailure;
      assertEgressAllowed(c, policy, call.tool, boundary);
    }
    if (signal?.aborted) throw new ApiError(409, "Cancelled before dispatch");
    if (this.provider.kind === "deterministic-fixture")
      return this.fixture(owner, id, call, policy, fence);
    return this.dispatch(owner, id, call, policy, signal, fence);
  }
  /** Fixture effects live in the conversation row: intent, effect and observation are one commit. */
  private async fixture(
    owner: string,
    id: string,
    call: ToolCall,
    policy: ToolPolicy,
    fence?: Fence,
  ) {
    const execId = executionId(owner, id, call.id);
    await this.fault("before-intent", { execId, tool: call.tool });
    const result = await this.store.mutate(owner, id, (state) => {
      assertFence(state, fence);
      const known = state.ledger?.[execId];
      if (known?.status === "observed") return known.observation!;
      assertNotBlocked(state);
      assertEgressAllowed(state, policy, call.tool, this.provider.egressBoundary);
      const result = fixtureExecute(state, call);
      const entry = this.newEntry(state, call, policy);
      this.observe(state, entry, call, policy, result);
      return result;
    });
    await this.fault("after-observation", { execId, tool: call.tool });
    return result;
  }
  private newEntry(state: Conversation, call: ToolCall, policy: ToolPolicy): LedgerEntry {
    const execId = executionId(state.owner, state.id, call.id);
    const entry: LedgerEntry = {
      execId,
      callId: call.id,
      tool: call.tool,
      replay: policy.replay,
      destination: policy.destination,
      argsDigest: fingerprint(call.args),
      args: call.args,
      policyVersion: this.policyVersion,
      epoch: state.epoch ?? 0,
      attempts: 1,
      status: "intent",
    };
    ledgerOf(state)[execId] = entry;
    return entry;
  }
  private observe(
    state: Conversation,
    entry: LedgerEntry,
    call: ToolCall,
    policy: ToolPolicy,
    result: ToolResult,
  ) {
    if ((result.productionData || policy.destination === "production") && !state.tainted) {
      state.tainted = true;
      append(state, "taint.changed", {
        tainted: true,
        reason: policy.destination === "production" ? "production" : "unexpected-production",
        callId: call.id,
      });
    }
    entry.status = "observed";
    entry.observation = result;
    delete entry.error;
    state.receipts[`tool:${call.id}`] = { fingerprint: fingerprint(call), result };
    append(state, "tool.result", {
      tool: call.tool,
      callId: call.id,
      execId: entry.execId,
      attempt: entry.attempts,
      ...result,
    });
  }
  /** Answers a call the ledger already holds, applying its declared replay class. */
  private async resume(
    owner: string,
    id: string,
    call: ToolCall,
    entry: LedgerEntry,
    signal?: AbortSignal,
    fence?: Fence,
  ): Promise<ToolResult> {
    switch (entry.status) {
      case "observed":
        return entry.observation!;
      case "failed":
        throw new ApiError(409, `Tool call already failed: ${entry.error ?? "error"}`);
      case "unknown":
        throw new ApiError(
          409,
          "Tool outcome unknown after restart; automatic replay denied until it is resolved",
          "tool_outcome_unknown",
        );
      case "resolved":
        throw new ApiError(
          409,
          `Tool outcome was resolved as ${entry.resolution?.outcome}; it is not replayed`,
        );
    }
    const policy = this.policy(call.tool);
    // Replay only when the class recorded with the intent and the current one agree.
    if (entry.replay === "non-idempotent" || policy.replay !== entry.replay) {
      await this.store.mutate(owner, id, (state) => {
        const e = state.ledger?.[entry.execId];
        if (e)
          markUnknown(state, e, "Interrupted after its intent was recorded; replay is not safe");
      });
      throw new ApiError(
        409,
        "Tool outcome unknown after restart; automatic replay denied until it is resolved",
        "tool_outcome_unknown",
      );
    }
    if (entry.replay === "safe-read" && entry.attempts >= SAFE_READ_MAX_ATTEMPTS) {
      await this.store.mutate(owner, id, (state) => {
        const e = state.ledger?.[entry.execId];
        if (e?.status === "intent") {
          e.status = "failed";
          e.error = `Safe read interrupted ${e.attempts} times; retry bound reached`;
          append(state, "tool.failed", { execId: e.execId, callId: e.callId, error: e.error });
        }
      });
      throw new ApiError(409, `Tool call already failed: safe read retry bound reached`);
    }
    return this.dispatch(owner, id, call, policy, signal, fence);
  }
  /** Intent → effect → observation, each commit under the current epoch. */
  private async dispatch(
    owner: string,
    id: string,
    call: ToolCall,
    policy: ToolPolicy,
    signal?: AbortSignal,
    fence?: Fence,
  ): Promise<ToolResult> {
    const execId = executionId(owner, id, call.id);
    await this.fault("before-intent", { execId, tool: call.tool });
    const intent = await this.store.mutate(owner, id, (state) => {
      assertFence(state, fence);
      assertNotBlocked(state);
      assertEgressAllowed(state, policy, call.tool, this.provider.egressBoundary);
      let entry = state.ledger?.[execId];
      if (entry && entry.status !== "intent") return structuredClone(entry);
      if (entry) {
        entry.attempts++;
        entry.epoch = state.epoch ?? 0;
        entry.policyVersion = this.policyVersion;
      } else entry = this.newEntry(state, call, policy);
      append(state, "tool.intent", {
        execId,
        callId: call.id,
        tool: call.tool,
        replay: entry.replay,
        destination: entry.destination,
        argsDigest: entry.argsDigest,
        epoch: entry.epoch,
        policyVersion: entry.policyVersion,
        attempt: entry.attempts,
      });
      return structuredClone(entry);
    });
    if (intent.status !== "intent") return this.resume(owner, id, call, intent, signal, fence);
    await this.fault("after-intent", { execId, tool: call.tool });
    // Only for our own intent epoch: a newer owner's record is never overwritten.
    const settle = (status: "failed" | "unknown", reason: string) =>
      this.store.mutate(owner, id, (state) => {
        const e = state.ledger?.[execId];
        if (!e || e.status !== "intent" || e.epoch !== intent.epoch) return;
        if (status === "unknown") markUnknown(state, e, reason);
        else {
          e.status = "failed";
          e.error = reason;
          append(state, "tool.failed", { execId, callId: call.id, error: reason });
        }
      });
    if (signal?.aborted) {
      // Same process, before dispatch: it certainly did not run.
      await settle("failed", "Cancelled before dispatch");
      throw new ApiError(409, "Cancelled before dispatch");
    }
    let result: ToolResult;
    try {
      const current = await read(this.store, owner, id);
      result = await this.provider.execute(current.sandbox!, call, signal, {
        ...(policy.replay === "idempotent-write" ? { idempotencyKey: execId } : {}),
        execId,
        epoch: intent.epoch,
        owner,
        conversationId: id,
        tainted: current.tainted,
      });
    } catch (error) {
      // A 4xx from the provider is a definite rejection. Anything else (network, 5xx,
      // abort mid-flight) leaves the effect uncertain.
      const definite = error instanceof ApiError && error.status < 500;
      const reason = error instanceof Error ? error.message : String(error);
      if (policy.replay === "safe-read" || definite) await settle("failed", reason);
      else if (policy.replay === "non-idempotent")
        await settle("unknown", `Dispatch failed without a definite answer: ${reason}`);
      // An idempotent write stays an intent: re-sending it with its key is safe.
      throw error;
    }
    await this.fault("after-effect", { execId, tool: call.tool });
    const committed = await this.store.mutate(owner, id, (state) => {
      const e = state.ledger?.[execId];
      if (!e) throw new ApiError(409, "Ledger entry disappeared");
      let fenceCurrent = true;
      try {
        assertFence(state, fence);
      } catch {
        fenceCurrent = false;
      }
      // Commit only for the attempt that is still current: our intent, our epoch, and (on
      // the unfenced gateway path) no newer lease since the intent.
      if (
        fenceCurrent &&
        e.status === "intent" &&
        e.epoch === intent.epoch &&
        e.attempts === intent.attempts &&
        (state.epoch ?? 0) === intent.epoch
      ) {
        this.observe(state, e, call, policy, result);
        return true;
      }
      // Late: kept as evidence for reconciliation only. It never commits a result or a
      // receipt and never changes the entry's status (an unknown stays unknown).
      (e.lateObservations ??= []).push({
        epoch: intent.epoch,
        attempt: intent.attempts,
        currentEpoch: state.epoch ?? 0,
        statusAtArrival: e.status,
        ...(fence ? { worker: fence.worker } : {}),
        result,
      });
      append(state, "tool.late_observation", {
        execId,
        callId: call.id,
        tool: call.tool,
        epoch: intent.epoch,
        currentEpoch: state.epoch ?? 0,
        status: e.status,
      });
      // Taint only ever restricts, so production data in late evidence still taints.
      if ((result.productionData || policy.destination === "production") && !state.tainted) {
        state.tainted = true;
        append(state, "taint.changed", {
          tainted: true,
          reason: "late-observation",
          callId: call.id,
        });
      }
      return false;
    });
    if (!committed) {
      if (fence) throw new StaleOwnerError();
      throw new ApiError(
        409,
        "Late observation recorded as evidence only; the tool outcome was not committed",
        "tool_observation_late",
      );
    }
    await this.fault("after-observation", { execId, tool: call.tool });
    return result;
  }
}
