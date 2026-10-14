/**
 * Files panel: read-only browsing of a conversation's sandbox /workspace for the user.
 *
 * - User-only: not a Pi tool, not in the tool ledger, never taints. Runs inside the sandbox
 *   through the same Nomad exec path as hands commands (no host filesystem access).
 * - Confinement: paths are workspace-relative (no absolute paths, no `..`, no control
 *   characters); inside the sandbox the target is resolved with `realpath -e` and must stay
 *   under realpath(/workspace), so symlinks cannot escape.
 * - Limits: entries per listing, search results, bytes per file read (larger files are cut and
 *   marked truncated), binary detection (NUL byte in the first 8 KiB, or invalid UTF-8), and a
 *   deadline per command.
 * - Lifecycle: like the terminal, a request starts (or restores) a stopped sandbox; each
 *   request counts as activity for the idle reaper.
 */
import type { HandsExecRequest, HandsExecResult } from "./hands.ts";
import { ApiError } from "./store.ts";

export interface SandboxFilesOptions {
  /** Start the conversation's sandbox if needed (applying its egress policy). */
  prepare(owner: string, conversationId: string): Promise<unknown>;
  /** Run argv in the sandbox (no host shell). */
  exec(owner: string, conversationId: string, request: HandsExecRequest): Promise<HandsExecResult>;
  /** Browsing keeps the sandbox from idling out. */
  touch?(owner: string, conversationId: string): void;
  maxEntries?: number;
  maxSearchResults?: number;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  /** After a successful save (the engine tells Pi at its next turn). */
  onWrite?(owner: string, conversationId: string, relativePath: string): Promise<void>;
  deadlineMs?: number;
}
export interface FileEntry {
  path: string;
  kind: "file" | "directory";
}

const MAX_PATH = 1024;
/** Workspace-relative path; "" is the root. Rejects anything that could name outside it. */
export function workspacePath(value: unknown, allowRoot = true): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new ApiError(400, "path must be a string");
  let p = value.trim().replace(/^\.\/+/, "");
  p = p.replace(/\/+$/, "");
  if (p === ".") p = "";
  if (!p && !allowRoot) throw new ApiError(400, "path is required");
  if (p.length > MAX_PATH) throw new ApiError(400, "path too long");
  if (p.startsWith("/") || p.startsWith("~"))
    throw new ApiError(400, "path must be relative to /workspace");
  if (/[\u0000-\u001f\u007f\\]/.test(p)) throw new ApiError(400, "invalid characters in path");
  if (p && p.split("/").some((s) => s === ".." || s === "." || s === ""))
    throw new ApiError(400, "path must not contain '.', '..' or empty segments");
  return p;
}

/**
 * The in-sandbox script. Arguments: op, relative path (or search query), limit.
 * Exit codes: 10 no workspace, 11 not found, 12 outside workspace, 13 wrong type.
 */
export const FILES_SCRIPT = String.raw`set -u
root=$(realpath -e /workspace 2>/dev/null) || exit 10
op=$1; arg=$2; lim=$3
resolve() {
  if [ -z "$1" ]; then t=$root; else t=$(realpath -e -- "$root/$1" 2>/dev/null) || exit 11; fi
  case "$t" in "$root"|"$root"/*) ;; *) exit 12;; esac
}
case "$op" in
  list)
    resolve "$arg"; [ -d "$t" ] || exit 13
    cd -- "$t" && find . -mindepth 1 -maxdepth 1 -printf '%Y %P\0' 2>/dev/null | head -z -n $((lim + 1))
    ;;
  read)
    resolve "$arg"; [ -f "$t" ] || exit 13
    size=$(stat -L -c %s -- "$t") || exit 11
    nul=$(head -c 8192 -- "$t" | tr -dc '\000' | wc -c)
    ver=$(sha256sum -- "$t" | cut -c1-64) || exit 11
    if [ "$nul" -gt 0 ]; then printf '%s binary %s\n' "$size" "$ver"; exit 0; fi
    printf '%s text %s\n' "$size" "$ver"; head -c "$lim" -- "$t" | base64 -w0
    ;;
  write)
    # arg: relative path; $4: expected version ("new" = must not exist); contents on stdin.
    # (No brace expansions: this script lives in a JS template literal.)
    expected=""; [ $# -ge 4 ] && expected=$4
    case "$arg" in */*) pdir=$(dirname -- "$arg"); name=$(basename -- "$arg");; *) pdir=""; name=$arg;; esac
    resolve "$pdir"; [ -d "$t" ] || exit 13
    target="$t/$name"
    if [ -e "$target" ] || [ -L "$target" ]; then
      real=$(realpath -e -- "$target" 2>/dev/null) || exit 12
      case "$real" in "$root"/*) ;; *) exit 12;; esac
      [ -f "$real" ] || exit 13
      current=$(sha256sum -- "$real" | cut -c1-64) || exit 11
      if [ "$current" != "$expected" ]; then printf '%s\n' "$current"; exit 14; fi
      target=$real
    else
      [ "$expected" = "new" ] || { printf 'missing\n'; exit 14; }
    fi
    dir=$(dirname -- "$target")
    tmp=$(mktemp -- "$dir/.linguini-write.XXXXXX") || exit 15
    trap 'rm -f -- "$tmp"' EXIT
    head -c "$((lim + 1))" > "$tmp"
    [ "$(stat -c %s -- "$tmp")" -le "$lim" ] || exit 16
    if [ -e "$target" ]; then chmod --reference="$target" -- "$tmp" && chown --reference="$target" -- "$tmp" 2>/dev/null; else chmod 0644 -- "$tmp"; fi
    mv -f -- "$tmp" "$target" || exit 15
    trap - EXIT
    sha256sum -- "$target" | cut -c1-64
    ;;
  image)
    # Visual replies: one sandbox image as base64, at most lim bytes (exit 16 when larger).
    resolve "$arg"; [ -f "$t" ] || exit 13
    size=$(stat -L -c %s -- "$t") || exit 11
    [ "$size" -le "$lim" ] || exit 16
    head -c "$lim" -- "$t" | base64 -w0
    ;;
  search)
    cd -- "$root" && find . -mindepth 1 -maxdepth 12 \( -name .git -o -name node_modules -o -name .cache \) -prune -o -ipath "*$arg*" -printf '%Y %P\0' 2>/dev/null | head -z -n $((lim + 1))
    ;;
  *) exit 2;;
esac
`;

const FAILURES: Record<number, [number, string]> = {
  10: [503, "The sandbox has no /workspace"],
  11: [404, "No such file or directory"],
  12: [403, "Path resolves outside /workspace"],
  13: [400, "Wrong kind of entry (file vs. directory)"],
  15: [502, "Could not write the file"],
  16: [413, "File too large"],
};
const globEscape = (s: string) => s.replace(/[\\*?[\]]/g, "\\$&");

export class SandboxFiles {
  private readonly maxEntries: number;
  private readonly maxSearch: number;
  private readonly maxRead: number;
  private readonly deadlineMs: number;
  private readonly maxWrite: number;
  private seq = 0;
  constructor(private readonly o: SandboxFilesOptions) {
    this.maxEntries = o.maxEntries ?? 1000;
    this.maxSearch = o.maxSearchResults ?? 200;
    this.maxRead = o.maxReadBytes ?? 1024 * 1024;
    this.deadlineMs = o.deadlineMs ?? 15_000;
    this.maxWrite = o.maxWriteBytes ?? 5 * 1024 * 1024;
  }
  private async run(
    owner: string,
    id: string,
    op: string,
    arg: string,
    limit: number,
    outLimit: number,
    extra: { stdin?: string; expected?: string } = {},
  ) {
    await this.o.prepare(owner, id);
    this.o.touch?.(owner, id);
    const r = await this.o.exec(owner, id, {
      execId: `files-${Date.now()}-${++this.seq}`,
      epoch: 0,
      callId: `files:${op}`,
      argv: [
        "bash",
        "-c",
        FILES_SCRIPT,
        "linguini-files",
        op,
        arg,
        String(limit),
        ...(extra.expected === undefined ? [] : [extra.expected]),
      ],
      ...(extra.stdin === undefined ? {} : { stdin: extra.stdin }),
      deadlineMs: this.deadlineMs,
      outputLimitBytes: outLimit,
    });
    if (r.exitCode === 14)
      throw new ApiError(
        409,
        r.stdout.trim() === "missing"
          ? "File changed: it no longer exists in the sandbox"
          : "File changed in the sandbox since it was opened",
        "file_changed",
      );
    const failure = FAILURES[r.exitCode];
    if (failure) throw new ApiError(failure[0], failure[1]);
    if (r.exitCode !== 0) throw new ApiError(502, `File operation failed (exit ${r.exitCode})`);
    return r;
  }
  private entries(stdout: string, limit: number) {
    const raw = stdout.split("\0").filter(Boolean);
    const entries: FileEntry[] = [];
    for (const line of raw.slice(0, limit)) {
      const type = line[0];
      const path = line.slice(2);
      if (!path || type === "N" || type === "L") continue; // broken symlink or loop
      entries.push({ path, kind: type === "d" ? "directory" : "file" });
    }
    return { entries, truncated: raw.length > limit };
  }
  async list(owner: string, id: string, directory: unknown) {
    const dir = workspacePath(directory);
    const r = await this.run(owner, id, "list", dir, this.maxEntries, this.maxEntries * 1100);
    const { entries, truncated } = this.entries(r.stdout, this.maxEntries);
    return {
      entries: entries.map((e) => ({ ...e, path: dir ? `${dir}/${e.path}` : e.path })),
      truncated: truncated || r.truncated,
    };
  }
  async search(owner: string, id: string, query: unknown, limit?: unknown) {
    const q = typeof query === "string" ? query.trim().slice(0, 256) : "";
    if (/[\u0000-\u001f\u007f]/.test(q)) throw new ApiError(400, "invalid characters in query");
    const n = Math.min(
      this.maxSearch,
      typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : this.maxSearch,
    );
    const r = await this.run(owner, id, "search", globEscape(q), n, n * 1100);
    return this.entries(r.stdout, n);
  }
  /**
   * Atomic save: temp file in the same directory, mode/owner copied, then rename. The caller
   * passes the version it read (sha256 of the file) or "new" for a file that must not exist yet;
   * anything else on disk is a 409 file_changed. Symlinks are written through only when they
   * resolve inside /workspace; new files need an existing parent directory.
   */
  async write(
    owner: string,
    id: string,
    path: unknown,
    contents: unknown,
    expectedVersion: unknown,
  ) {
    const rel = workspacePath(path, false);
    if (typeof contents !== "string") throw new ApiError(400, "contents must be a string");
    if (Buffer.byteLength(contents) > this.maxWrite)
      throw new ApiError(413, `File too large (limit ${this.maxWrite} bytes)`);
    const expected = typeof expectedVersion === "string" ? expectedVersion : "";
    if (expected !== "new" && !/^[0-9a-f]{64}$/.test(expected))
      throw new ApiError(400, 'expectedVersion must be the version from the last read, or "new"');
    const r = await this.run(owner, id, "write", rel, this.maxWrite, 256, {
      stdin: contents,
      expected,
    });
    const version = r.stdout.trim();
    await this.o.onWrite?.(owner, id, rel);
    return { relativePath: rel, version };
  }
  /**
   * An image for a visual reply: the file's bytes (realpath-confined to /workspace like every
   * other op), or null when it is missing, not a regular file, outside /workspace or too large.
   */
  async readImage(
    owner: string,
    id: string,
    path: string,
    maxBytes: number,
  ): Promise<Buffer | null> {
    let rel: string;
    try {
      rel = workspacePath(path, false);
    } catch {
      return null;
    }
    try {
      const r = await this.run(
        owner,
        id,
        "image",
        rel,
        maxBytes,
        Math.ceil(maxBytes / 3) * 4 + 256,
      );
      if (r.truncated) return null;
      return Buffer.from(r.stdout.trim(), "base64");
    } catch (e) {
      if (e instanceof ApiError && [400, 403, 404, 413].includes(e.status)) return null;
      throw e;
    }
  }
  async read(owner: string, id: string, path: unknown) {
    const rel = workspacePath(path, false);
    const r = await this.run(
      owner,
      id,
      "read",
      rel,
      this.maxRead,
      Math.ceil(this.maxRead / 3) * 4 + 256,
    );
    const nl = r.stdout.indexOf("\n");
    const [sizeText, kind, version = ""] = r.stdout.slice(0, nl).split(" ");
    const size = Number(sizeText);
    if (!Number.isFinite(size)) throw new ApiError(502, "Unexpected file read output");
    if (kind === "binary")
      return {
        relativePath: rel,
        contents: "",
        byteLength: size,
        truncated: false,
        binary: true,
        version,
      };
    const bytes = Buffer.from(r.stdout.slice(nl + 1).trim(), "base64");
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(
        size > bytes.length ? trimPartialUtf8(bytes) : bytes,
      );
    } catch {
      return {
        relativePath: rel,
        contents: "",
        byteLength: size,
        truncated: false,
        binary: true,
        version,
      };
    }
    return {
      relativePath: rel,
      contents,
      byteLength: size,
      truncated: size > bytes.length,
      binary: false,
      version,
    };
  }
}
/** A cut at the byte limit may split a multi-byte character: drop the incomplete tail. */
function trimPartialUtf8(b: Buffer) {
  let i = b.length - 1,
    back = 0;
  while (i >= 0 && back < 4 && (b[i]! & 0xc0) === 0x80) (i--, back++);
  if (i < 0) return b;
  const lead = b[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return need > back + 1 ? b.subarray(0, i) : b;
}

const MAX_NOTED_EDITS = 50;
/** Adds a path to the "edited since Pi's last turn" list (deduplicated, most recent last, capped). */
export function recordUserEdit(list: string[] | undefined, path: string): string[] {
  const next = (list ?? []).filter((p) => p !== path);
  next.push(path);
  return next.slice(-MAX_NOTED_EDITS);
}
/** Context note prepended to Pi's next prompt; never journaled, so it stays out of the transcript. */
export function userEditNote(paths: readonly string[]): string {
  return (
    `[Linguini note: since your last turn the user edited these files in the Files panel: ` +
    `${paths.map((p) => `/workspace/${p}`).join(", ")}. Re-read them before relying on earlier contents.]`
  );
}
