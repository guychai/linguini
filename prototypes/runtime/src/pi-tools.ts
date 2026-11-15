// Model-facing descriptions and parameter schemas of the sandbox tools (durable-harness.ts).
import { Type } from "typebox";
import { HTML_PARAM_DESCRIPTIONS, HTML_TOOL_DESCRIPTIONS } from "./html-render.ts";
import type { ToolName } from "./sandbox.ts";

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
    "Share a port of this sandbox as a browser preview for the user. The server must listen on 0.0.0.0 (not 127.0.0.1) and serve under the base path in the returned URL. `label` is a short name shown to the user. Pages are always served with a sandboxing CSP (opaque origin: no cookies or localStorage for scripts; scripts, styles, images, fetch/WebSocket and form posts may reach only the preview itself, so bundle assets instead of loading CDNs). Returns the preview URL; idempotent.",
  unshare_port: "Stop sharing a previously shared preview port.",
  ...HTML_TOOL_DESCRIPTIONS,
};
/** Parameter schemas of the sandbox tools. */
export function toolSchemas() {
  return {
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
}
