/**
 * T3's Files surface (projects.listEntries / readFile / searchEntries / writeFile) over the owned
 * backend's sandbox file API. Saves are version-checked: the version of the last read (or our own
 * save) of a path rides along, and a file changed in the sandbox since then is a 409 conflict,
 * surfaced as an error so T3 keeps the edit unsaved instead of overwriting. T3 addresses files by workspace root (cwd) only, so the
 * conversation comes from the route the user is viewing (/<environment>/<threadId>).
 */
export const FILE_COMMANDS = [
  "projects.listEntries",
  "projects.readFile",
  "projects.searchEntries",
  "projects.writeFile",
] as const;
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;
interface Known {
  version: string;
  truncated: boolean;
}
/** conversation + path -> what the editor's contents are based on. */
const known = new Map<string, Known>();
const key = (id: string, path: string) => `${id}\u0000${path}`;
export function resetFileVersions() {
  known.clear();
}
export interface FileDeps {
  fetch: typeof fetch;
  token: () => string;
  location: { pathname: string };
  /** Shows a failed save to the user (T3 itself only marks the tab unsaved); null clears it. */
  notify?: (text: string | null) => void;
}
const WORKSPACE = "/workspace";
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export function conversationFromPath(pathname: string): string | null {
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
  if (parts.length !== 2 || ["draft", "settings", "projects"].includes(parts[0]!)) return null;
  return ID.test(parts[1]!) ? parts[1]! : null;
}
/** Workspace-relative form of a path T3 sends (relative, or absolute under /workspace). */
export function relativeToWorkspace(path: unknown): string {
  const p = typeof path === "string" ? path.trim() : "";
  if (p === WORKSPACE) return "";
  if (p.startsWith(`${WORKSPACE}/`)) return p.slice(WORKSPACE.length + 1);
  if (p.startsWith("/")) throw new Error("Only files inside the sandbox /workspace can be shown");
  return p;
}
export async function fileCommand(tag: string, input: Record<string, any>, deps: FileDeps) {
  if (input.cwd !== WORKSPACE)
    throw new Error("Files are only available for the sandbox /workspace");
  const id = conversationFromPath(deps.location.pathname);
  if (!id)
    throw new Error("Send a message to start this conversation first; its files appear then.");
  const call = async (op: string, body: Record<string, unknown>) => {
    const response = await deps.fetch(`/api/conversations/${id}/files/${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.token()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok)
      throw Object.assign(
        new Error(value.error ?? `Files request failed (HTTP ${response.status})`),
        { code: value.code },
      );
    return value;
  };
  if (tag === "projects.listEntries") {
    const r = await call("list", { path: relativeToWorkspace(input.directoryPath ?? "") });
    return { entries: r.entries, truncated: r.truncated === true };
  }
  if (tag === "projects.searchEntries") {
    if (input.imageOnly) return { entries: [], truncated: false };
    const r = await call("search", { query: input.query ?? "", limit: input.limit });
    const entries = (r.entries as { path: string; kind: string }[]).filter(
      (e) => !input.kind || e.kind === input.kind,
    );
    return { entries, truncated: r.truncated === true };
  }
  const relativePath = relativeToWorkspace(input.relativePath);
  if (tag === "projects.writeFile") {
    const contents = typeof input.contents === "string" ? input.contents : "";
    const refuse = (text: string) => {
      deps.notify?.(text);
      return new Error(text);
    };
    if (new TextEncoder().encode(contents).byteLength > MAX_WRITE_BYTES)
      throw refuse(`${relativePath} is larger than 5 MiB; not saved.`);
    const base = known.get(key(id, relativePath));
    if (base?.truncated)
      throw refuse(`${relativePath} was only partly loaded (too large); not saved.`);
    try {
      const r = await call("write", {
        path: relativePath,
        contents,
        expectedVersion: base?.version ?? "new",
      });
      known.set(key(id, relativePath), { version: r.version, truncated: false });
      deps.notify?.(null);
      return { relativePath: r.relativePath };
    } catch (error) {
      const failure =
        (error as { code?: string }).code === "file_changed"
          ? new Error(
              `${relativePath} changed in the sandbox since you opened it, so your edits were not ` +
                `saved. Copy them, then close and reopen the file to load the latest version.`,
            )
          : new Error(`${relativePath} was not saved: ${(error as Error).message}`);
      deps.notify?.(failure.message);
      throw failure;
    }
  }
  const r = await call("read", { path: relativePath });
  if (typeof r.version === "string")
    known.set(key(id, relativePath), { version: r.version, truncated: r.truncated === true });
  if (r.binary)
    throw new Error(`${relativePath} is a binary file (${r.byteLength} bytes); not shown.`);
  return {
    relativePath: r.relativePath,
    contents: r.contents,
    byteLength: r.byteLength,
    truncated: r.truncated === true,
  };
}
