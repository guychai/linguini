// Durable tool-call ledger. Every tool declares a replay class and a destination; the
// broker commits an intent row (stable execution ID, args digest, destination, epoch,
// policy version) before dispatch and the observation after, both under the current
// lease epoch. Recovery follows the declared class: safe reads retry within a bound,
// idempotent writes are re-sent with the same idempotency key, and an interrupted
// non-idempotent call becomes "outcome unknown", which blocks further work in the
// conversation until someone resolves it. The ledger lives in the conversation row, so
// it commits atomically with taint, receipts and the lease.
import { createHash } from "node:crypto";
import { ApiError, append, type Conversation } from "./store.ts";
import type { ToolResult } from "./sandbox.ts";

export type ReplayClass = "safe-read" | "idempotent-write" | "non-idempotent";
export type Destination = "sandbox" | "production" | "publication";
export interface ToolPolicy {
  replay: ReplayClass;
  /** Where the call reads or writes. Anything from `production` taints the conversation. */
  destination: Destination;
  /**
   * Whether the call can move data out.
   * - `false`: no egress.
   * - `true`: direct egress (publication, an unproxied shell): denied once tainted.
   * - `"proxied"`: network egress only through the node's egress proxy, whose per-conversation
   *   allowlist is the boundary. After taint it is allowed only when the provider declares that
   *   boundary (`egressBoundary: "proxy"`), because that provider hands the taint to the proxy,
   *   which then narrows the allowlist. Otherwise it is denied like `true`.
   */
  egress: boolean | "proxied";
}
/** Who enforces egress for a provider's tools. Only "proxy" relaxes the taint rule for "proxied". */
export type EgressBoundary = "none" | "proxy";
export type ToolPolicies = Readonly<Record<string, ToolPolicy>>;

/** The declared policy of every sandbox tool. Policy decisions read this, never tool names. */
export const DEFAULT_TOOL_POLICIES: ToolPolicies = Object.freeze({
  read: { replay: "safe-read", destination: "sandbox", egress: false },
  // Non-idempotent until the remote sandbox is confirmed to honour idempotencyKey (one
  // effect per key, the original result on repeat). Then declare it "idempotent-write".
  write: { replay: "non-idempotent", destination: "sandbox", egress: false },
  // "Replace exactly once" is not idempotent: a second application fails or double-applies.
  edit: { replay: "non-idempotent", destination: "sandbox", egress: false },
  // Arbitrary commands in the sandbox. Network access leaves only through the egress proxy.
  bash: { replay: "non-idempotent", destination: "sandbox", egress: "proxied" },
  // Pi's other built-in tools. All of them run in the sandbox, never on the host.
  grep: { replay: "safe-read", destination: "sandbox", egress: false },
  find: { replay: "safe-read", destination: "sandbox", egress: false },
  ls: { replay: "safe-read", destination: "sandbox", egress: false },
  // Preview ports: an upsert/delete of this conversation's share (same effect when repeated).
  // Exposes the sandbox port to the conversation's owner over the tailnet only; no egress.
  share_port: { replay: "idempotent-write", destination: "sandbox", egress: false },
  unshare_port: { replay: "idempotent-write", destination: "sandbox", egress: false },
});
/** PR creation and publishing: egress to a publication destination. */
export const PUBLICATION_POLICY: ToolPolicy = Object.freeze({
  replay: "non-idempotent",
  destination: "publication",
  egress: true,
});
/** Interrupted safe reads are retried this many times in total, then fail. */
export const SAFE_READ_MAX_ATTEMPTS = 3;

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Changes whenever any declared policy changes; recorded with every intent. */
export function policyVersion(policies: ToolPolicies) {
  const sorted = Object.keys(policies)
    .sort()
    .map((name) => [
      name,
      policies[name]!.replay,
      policies[name]!.destination,
      policies[name]!.egress,
    ]);
  return `v1:${sha(sorted).slice(0, 12)}`;
}
/** Stable across redeliveries and restarts: a function of the conversation and the call ID. */
export function executionId(owner: string, conversationId: string, callId: string) {
  return `x${sha([owner, conversationId, callId]).slice(0, 32)}`;
}

export type LedgerStatus = "intent" | "observed" | "failed" | "unknown" | "resolved";
export interface LedgerEntry {
  execId: string;
  callId: string;
  tool: string;
  replay: ReplayClass;
  destination: Destination;
  argsDigest: string;
  /** Kept with the intent so recovery can re-send safe reads and idempotent writes. */
  args: Record<string, unknown>;
  policyVersion: string;
  /** Lease epoch of the latest intent commit. */
  epoch: number;
  attempts: number;
  status: LedgerStatus;
  observation?: ToolResult;
  error?: string;
  resolution?: { outcome: "applied" | "not-applied"; note?: string };
  /**
   * Observations that arrived after their attempt stopped being current (lease lost, epoch
   * advanced, or the entry already unknown). Evidence for reconciliation only.
   */
  lateObservations?: Array<{
    epoch: number;
    attempt: number;
    currentEpoch: number;
    statusAtArrival: LedgerStatus;
    worker?: string;
    result: ToolResult;
  }>;
}

export function ledgerOf(c: Conversation): Record<string, LedgerEntry> {
  return (c.ledger ??= {});
}
/** Calls whose outcome is unknown and unresolved. Any of them blocks further work. */
export function unresolved(c: Conversation): LedgerEntry[] {
  return Object.values(c.ledger ?? {}).filter((e) => e.status === "unknown");
}
export function assertNotBlocked(c: Conversation, except?: string) {
  const blocking = unresolved(c).find((e) => e.execId !== except);
  if (blocking)
    throw new ApiError(
      409,
      `Blocked: the outcome of ${blocking.tool} call ${blocking.callId} (${blocking.execId}) is unknown; resolve it before more work runs`,
      "tool_outcome_unknown",
    );
}
export function assertEgressAllowed(
  c: Conversation,
  policy: ToolPolicy,
  tool: string,
  boundary: EgressBoundary = "none",
) {
  if (!c.tainted || !policy.egress) return;
  if (policy.egress === "proxied" && boundary === "proxy") return;
  if (policy.destination === "publication")
    throw new ApiError(403, "Production-data taint permanently blocks PR and publication actions");
  throw new ApiError(
    403,
    `Tool "${tool}" disabled after production-data ingress: it is declared egress-capable`,
  );
}
export function markUnknown(c: Conversation, e: LedgerEntry, reason: string) {
  if (e.status !== "intent") return;
  e.status = "unknown";
  e.error = reason;
  append(c, "tool.outcome_unknown", {
    execId: e.execId,
    callId: e.callId,
    tool: e.tool,
    destination: e.destination,
    epoch: e.epoch,
    reason,
  });
}
/**
 * Runs inside the transaction that takes a new lease. An interrupted non-idempotent
 * call from an earlier epoch may or may not have taken effect: it becomes unknown.
 * Safe reads and idempotent writes stay as intents; the broker's recovery re-sends them.
 */
export function reconcileOnAcquire(c: Conversation, epoch: number) {
  for (const e of Object.values(c.ledger ?? {}))
    if (e.status === "intent" && e.epoch < epoch && e.replay === "non-idempotent")
      markUnknown(
        c,
        e,
        "Interrupted mid-flight by a lost worker; it may or may not have taken effect",
      );
}
/** Operator resolution of an unknown outcome, after inspecting the destination. */
export function resolveUnknown(
  c: Conversation,
  execId: string,
  outcome: "applied" | "not-applied",
  note?: string,
) {
  const e = c.ledger?.[execId];
  if (!e) throw new ApiError(404, "Unknown tool execution");
  if (e.status !== "unknown") throw new ApiError(409, `Tool execution is ${e.status}, not unknown`);
  e.status = "resolved";
  e.resolution = { outcome, ...(note ? { note: note.slice(0, 1000) } : {}) };
  append(c, "tool.outcome_resolved", { execId, callId: e.callId, tool: e.tool, outcome });
}
