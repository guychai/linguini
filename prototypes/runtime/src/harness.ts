// The harness interface the engine drives, and the deterministic fixture harness. The fixture
// is test-only: own-main runs it only with HARNESS_MODE=fixture (CI and browser e2e); the model
// harness is Pi Durable (durable-harness.ts).
import { assertFence, read, type Fence } from "./store.ts";
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
