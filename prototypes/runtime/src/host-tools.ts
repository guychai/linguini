// Host-tool registry (V1.1b, egress-first design). Host tools run on the backend, not in the
// sandbox: previews, visual replies, and later trino_query / github_create_pr. Each one declares
// the kinds of place it may write and, per call, the concrete destinations. The broker checks
// them before the ledger intent and again inside the intent commit: a destination whose kind
// the tool did not declare, or that the tool's own `permit` refuses, is 403 `destination_denied`.
// There is no sensitive-thread state: what a conversation read never changes what it may write.
// Sandbox tools (bash, files) are not in the registry: the egress proxy is their boundary.
import { ApiError } from "./store.ts";
import { DEFAULT_TOOL_POLICIES, type ToolPolicies, type ToolPolicy } from "./ledger.ts";
import type { ToolCall, ToolResult } from "./sandbox.ts";

export type WriteKind =
  /** The owner's browser (a shared preview port). Crosses the boundary. */
  | "owner-browser"
  /** Linguini's own per-conversation storage (rendered pages). Inside the boundary. */
  | "conversation-store"
  /** A GitHub repository (V1.2 github_create_pr). Crosses the boundary. */
  | "github";
export interface WriteDestination {
  kind: WriteKind;
  /** What is written, e.g. `port:3000` or `octo/repo@linguini/x`. Shown in denials. */
  target: string;
  /** Data written here leaves Linguini (descriptive: audit and denials). */
  crossesBoundary: boolean;
}
export interface HostToolContext {
  owner: string;
  conversationId: string;
}
export interface HostToolRun extends HostToolContext {
  execId: string;
  epoch: number;
  /** Set for idempotent-write tools: one effect per key. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}
export interface HostTool {
  policy: ToolPolicy;
  /** Kinds this tool may write. A computed destination of another kind is refused. */
  writes: readonly WriteKind[];
  /** Every destination this call would write (empty: none). Pure: no side effects. */
  destinations(call: ToolCall, ctx: HostToolContext): WriteDestination[];
  /** Deployment-specific allowlist for a destination (e.g. repos the App is installed on). */
  permit?(destination: WriteDestination, ctx: HostToolContext): boolean;
  handler(call: ToolCall, run: HostToolRun): Promise<ToolResult>;
  /**
   * Model-facing description and JSON-schema parameters, for tools that are not sandbox tools
   * (pi-tools.ts has those). A host tool without them is not offered to the model.
   */
  description?: string;
  parameters?: object;
}

export class HostToolRegistry {
  private readonly tools: Readonly<Record<string, HostTool>>;
  constructor(tools: Record<string, HostTool | undefined>) {
    this.tools = Object.freeze(
      Object.fromEntries(Object.entries(tools).filter(([, t]) => t !== undefined)) as Record<
        string,
        HostTool
      >,
    );
  }
  has(tool: string): boolean {
    return Object.hasOwn(this.tools, tool);
  }
  get(tool: string): HostTool | undefined {
    return this.has(tool) ? this.tools[tool] : undefined;
  }
  names(): string[] {
    return Object.keys(this.tools);
  }
  policies(): Record<string, ToolPolicy> {
    return Object.fromEntries(Object.entries(this.tools).map(([name, t]) => [name, t.policy]));
  }
  /** Throws 403 on any refused destination; returns the destinations when all are allowed. */
  check(call: ToolCall, ctx: HostToolContext): WriteDestination[] {
    const tool = this.get(call.tool);
    if (!tool) throw new ApiError(400, "Invalid tool call");
    const destinations = tool.destinations(call, ctx);
    for (const d of destinations) {
      if (!tool.writes.includes(d.kind) || (tool.permit && !tool.permit(d, ctx)))
        throw new ApiError(
          403,
          `Tool "${call.tool}" may not write to ${d.kind} ${d.target}`,
          "destination_denied",
        );
    }
    return destinations;
  }
}

/** share_port / unshare_port: record the share, then refresh the sandbox's preview env file. */
export function previewHostTools(o: {
  policies?: ToolPolicies;
  tools: (owner: string, id: string, call: ToolCall) => Promise<{ text: string; envFile: string }>;
  /** Installs the env file in the sandbox when it is running (else on its next start). */
  refreshEnv(owner: string, id: string): Promise<string | undefined>;
}): Record<"share_port" | "unshare_port", HostTool> {
  const handler = async (call: ToolCall, run: HostToolRun) => {
    const out = await o.tools(run.owner, run.conversationId, call);
    const warning = await o
      .refreshEnv(run.owner, run.conversationId)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    return {
      text: warning
        ? `${out.text}\n(warning: updating the sandbox preview env failed: ${warning.slice(0, 200)})`
        : out.text,
    };
  };
  return {
    share_port: {
      policy: (o.policies ?? DEFAULT_TOOL_POLICIES)["share_port"]!,
      writes: ["owner-browser"],
      destinations: (call) => [
        { kind: "owner-browser", target: `port:${String(call.args.port)}`, crossesBoundary: true },
      ],
      handler,
    },
    // Only removes access.
    unshare_port: {
      policy: (o.policies ?? DEFAULT_TOOL_POLICIES)["unshare_port"]!,
      writes: [],
      destinations: () => [],
      handler,
    },
  };
}

/** html_preview (image for the model only) / html_render (page stored in this conversation). */
export function visualHostTools(o: {
  policies?: ToolPolicies;
  execute(owner: string, id: string, call: ToolCall): Promise<ToolResult>;
}): Record<"html_preview" | "html_render", HostTool> {
  const handler = (call: ToolCall, run: HostToolRun) =>
    o.execute(run.owner, run.conversationId, call);
  return {
    html_preview: {
      policy: (o.policies ?? DEFAULT_TOOL_POLICIES)["html_preview"]!,
      writes: [],
      destinations: () => [],
      handler,
    },
    html_render: {
      policy: (o.policies ?? DEFAULT_TOOL_POLICIES)["html_render"]!,
      writes: ["conversation-store"],
      destinations: () => [
        { kind: "conversation-store", target: "renders", crossesBoundary: false },
      ],
      handler,
    },
  };
}
