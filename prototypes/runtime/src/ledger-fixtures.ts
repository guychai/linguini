// Deterministic fakes for the tool-ledger tests (test support, not production code).
import { DatabaseSync } from "node:sqlite";
import type { Fence } from "./store.ts";
import { DEFAULT_TOOL_POLICIES, type ToolPolicies } from "./ledger.ts";
import type { Harness, Sink } from "./harness.ts";
import type { SandboxBroker, SandboxProvider, ToolCall, ToolResult } from "./sandbox.ts";

/**
 * An external destination with its own database, separate from the conversation store, as
 * a real service would be. It survives the process kills. `read` has no effect; a call
 * that carries an idempotency key (only idempotent-write tools do) applies at most one
 * effect per key; every other call applies one effect per dispatch, with no deduplication.
 */
export class FakeDestination implements SandboxProvider {
  readonly kind = "remote";
  private db: DatabaseSync;
  failNext?: Error;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS dispatches (n INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, call TEXT, key TEXT);
      CREATE TABLE IF NOT EXISTS effects (n INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, call TEXT, key TEXT UNIQUE, result TEXT);`);
  }
  async allocate() {
    return "fake-destination";
  }
  async classify() {
    return "ordinary" as const;
  }
  async execute(
    _sandbox: string,
    call: ToolCall,
    _signal?: AbortSignal,
    options: { idempotencyKey?: string } = {},
  ): Promise<ToolResult> {
    const key = options.idempotencyKey ?? null;
    this.db
      .prepare("INSERT INTO dispatches (tool, call, key) VALUES (?, ?, ?)")
      .run(call.tool, call.id, key);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    if (call.tool === "read")
      return { text: `contents of ${String(call.args.path)}`, productionData: false };
    if (key) {
      const prior = this.db.prepare("SELECT result FROM effects WHERE key = ?").get(key) as
        | { result: string }
        | undefined;
      if (prior) return JSON.parse(prior.result) as ToolResult;
    }
    const n = this.count("effects") + 1;
    const result = { text: `effect #${n} applied by ${call.tool}`, productionData: false };
    this.db
      .prepare("INSERT INTO effects (tool, call, key, result) VALUES (?, ?, ?, ?)")
      .run(call.tool, call.id, key, JSON.stringify(result));
    return result;
  }
  count(table: "dispatches" | "effects") {
    return Number((this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  }
  keys() {
    return (
      this.db.prepare("SELECT key FROM dispatches ORDER BY n").all() as Array<{
        key: string | null;
      }>
    ).map((r) => r.key);
  }
  close() {
    this.db.close();
  }
}
/**
 * Test policies: the production table plus `fixture_put`, an idempotent-write tool that only
 * the fake destination implements (it honours idempotency keys), so the idempotent-write
 * mechanism stays proven while no production tool declares that class.
 */
export const LEDGER_TEST_POLICIES: ToolPolicies = Object.freeze({
  ...DEFAULT_TOOL_POLICIES,
  fixture_put: { replay: "idempotent-write", destination: "sandbox", egress: false },
});
/** The ledger-test tools: one per replay class. */
export const LEDGER_CALLS = {
  "safe-read": { tool: "read", args: { path: "notes.txt" } },
  "idempotent-write": { tool: "fixture_put", args: { key: "out", value: "v1" } },
  "non-idempotent": { tool: "edit", args: { path: "out.txt", oldText: "a", newText: "b" } },
} as const;
/** Issues one scripted tool call through the broker under the job's fence. */
export class ScriptedHarness implements Harness {
  constructor(
    private broker: SandboxBroker,
    private owner: string,
    private id: string,
    private jobId: string,
    private fence: Fence | undefined,
    private call: { tool: string; args: Record<string, unknown> },
  ) {}
  async run(_text: string, _history: string, emit: Sink, signal: AbortSignal) {
    const call = { id: `${this.jobId}:call-1`, ...this.call };
    await emit("tool.started", { tool: call.tool, callId: call.id, args: call.args });
    const result = await this.broker.execute(this.owner, this.id, call, signal, this.fence);
    await emit("tool.output", { callId: call.id, tool: call.tool, text: result.text });
  }
  async steer() {}
  async abort() {}
  dispose() {}
}
