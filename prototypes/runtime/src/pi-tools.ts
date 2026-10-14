import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HTML_PARAM_DESCRIPTIONS, HTML_TOOL_DESCRIPTIONS } from "./html-render.ts";
import type { ToolCall, ToolName, ToolResult } from "./sandbox.ts";

/** What each tool really does in the sandbox (kept in step with sandboxArgv in hands.ts). */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  bash: "Run a command with `bash -c` in /workspace inside the sandbox (root). Returns stdout, stderr and the exit code. `timeout` is in seconds (default 120, max 600); output is capped at 256 KiB.",
  read: "Read a text file in the sandbox. Path relative to /workspace. `offset` is the first line (1-based), `limit` the number of lines; use them for large files.",
  write:
    "Create or overwrite a file in the sandbox with `content` (parent directories are created). Path relative to /workspace.",
  edit: "Replace `oldText` with `newText` in a sandbox file; `oldText` must match exactly once.",
  grep: "Search file contents recursively in the sandbox (extended regex; `literal` for fixed strings, `ignoreCase`, `context` lines). `path` defaults to /workspace; `glob` filters file names (e.g. *.ts); `limit` caps matching lines (default 100).",
  find: "Find files under `path` (default /workspace) whose relative path matches the glob `pattern` (e.g. **/*.json); `limit` caps results (default 1000).",
  ls: "List a directory in the sandbox (default /workspace); directories end with /. `limit` caps entries (default 500).",
  share_port:
    "Share a port of this sandbox as a browser preview for the user. The server must listen on 0.0.0.0 (not 127.0.0.1) and serve under the base path in the returned URL. `label` is a short name shown to the user. Pages are always served with CSP `sandbox allow-scripts allow-forms` (opaque origin: no cookies or localStorage for scripts). Returns the preview URL; idempotent.",
  unshare_port: "Stop sharing a previously shared preview port.",
  ...HTML_TOOL_DESCRIPTIONS,
};
export function sandboxTools(
  execute: (call: ToolCall, signal?: AbortSignal) => Promise<ToolResult>,
): ToolDefinition[] {
  const schemas = {
    read: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    write: Type.Object({ path: Type.String(), content: Type.String() }),
    edit: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
    bash: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    // Same parameters as Pi's built-in grep/find/ls, which are disabled: these run in the sandbox.
    grep: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
      ignoreCase: Type.Optional(Type.Boolean()),
      literal: Type.Optional(Type.Boolean()),
      context: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    find: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    ls: Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
    share_port: Type.Object({
      port: Type.Number(),
      label: Type.Optional(Type.String()),
    }),
    unshare_port: Type.Object({ port: Type.Number() }),
    html_preview: Type.Object({
      html: Type.String({ description: HTML_PARAM_DESCRIPTIONS.html }),
      width: Type.Optional(Type.Number({ description: HTML_PARAM_DESCRIPTIONS.width })),
      appearance: Type.Optional(
        Type.Union([Type.Literal("dark"), Type.Literal("light")], {
          description: HTML_PARAM_DESCRIPTIONS.appearance,
        }),
      ),
    }),
    html_render: Type.Object({
      html: Type.String({ description: HTML_PARAM_DESCRIPTIONS.html }),
      title: Type.String({ description: HTML_PARAM_DESCRIPTIONS.title }),
      height: Type.Number({ description: HTML_PARAM_DESCRIPTIONS.height }),
    }),
  };
  return (Object.entries(schemas) as Array<[ToolName, (typeof schemas)[ToolName]]>).map(
    ([name, parameters]) => ({
      name,
      label: name,
      description: TOOL_DESCRIPTIONS[name],
      parameters,
      execute: async (id, args, signal) => {
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error("Invalid tool parameters");
        const result = await execute(
          { id, tool: name, args: args as Record<string, unknown> },
          signal,
        );
        return {
          content: [
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
export default function sandboxExtension(pi: ExtensionAPI) {
  const endpoint = process.env.T3_SANDBOX_URL;
  const capability = process.env.T3_SANDBOX_CAPABILITY;
  if (!endpoint || !capability)
    throw new Error("Sandbox extension requires a scoped capability and gateway URL");
  for (const tool of sandboxTools(async (call, signal) => {
    const response = await fetch(new URL("/tools", endpoint), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${capability}` },
      body: JSON.stringify(call),
      signal,
    });
    const result = (await response.json()) as ToolResult & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Sandbox tool rejected");
    return result;
  }))
    pi.registerTool(tool);
  // Pi's direct !shell route is distinct from its bash tool.
  pi.on("user_bash", async () => ({
    result: {
      output: "Direct shell disabled; use the sandbox bash tool",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  }));
}
