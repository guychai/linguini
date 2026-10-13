/**
 * Workspace persistence across sandbox generations: on idle stop, snapshot the sandbox's
 * /workspace plus the inner Docker daemon's named volumes (Postgres/Redis data a conversation
 * runs through DinD) to S3-compatible storage; when the next generation first becomes ready,
 * restore it before any tool call or terminal sees the sandbox.
 *
 * - Archive: tar+gzip produced inside the sandbox (so the host never parses guest paths),
 *   streamed out over `nomad alloc exec` to a host temp file, checked (gunzip), then uploaded as a
 *   single PUT to `sandboxes/<workspaceId>/workspace.tar.gz` (atomic replace; the previous
 *   snapshot stays until the new one is complete).
 * - Inner containers are stopped (`docker stop`, graceful) first, so database files are
 *   consistent. Running processes, containers and images are not persisted; volumes and
 *   /workspace are. Volume labels (e.g. Compose's) are kept.
 * - A failed snapshot leaves the sandbox running (back to ready) and is retried on the next idle
 *   sweep; after `maxFailures` in a row it stops anyway and records a visible note.
 * - A failed restore never blocks the sandbox: it records `workspace.restore_failed` (shown in the
 *   UI) and drops /workspace/RESTORE_FAILED.md for the agent.
 */
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Writable } from "node:stream";
import { append, type Store } from "./store.ts";
import type { HandsBinding } from "./hands.ts";
import type { SandboxSuspender } from "./idle.ts";
import type { S3Client } from "./s3.ts";

export const SNAPSHOT_FORMAT = "linguini-ws/v1";
const MARKER = "/run/linguini-restore";

/** Inside the sandbox: archive to stdout. Logs go to stderr. */
export const SAVE_SCRIPT = `set -eu
st=$(mktemp -d /tmp/lsnap.XXXXXX)
trap 'rm -rf "$st"' EXIT
mkdir -p "$st/meta/volumes" /workspace
echo ${SNAPSHOT_FORMAT} > "$st/meta/format"
set -- -C / workspace
if docker info >/dev/null 2>&1; then
  ids=$(docker ps -q)
  if [ -n "$ids" ]; then docker stop -t 20 $ids >/dev/null 2>&1 || true; fi
  for v in $(docker volume ls -q); do
    [ -d "/var/lib/docker/volumes/$v/_data" ] || continue
    docker volume inspect -f '{{json .Labels}}' "$v" > "$st/meta/volumes/$v" 2>/dev/null || echo null > "$st/meta/volumes/$v"
  done
  if [ -n "$(ls "$st/meta/volumes")" ]; then
    set -- "$@" -C /var/lib/docker --exclude=volumes/metadata.db --exclude=volumes/backingFsBlockDev volumes
  fi
fi
tar -czf - --numeric-owner "$@" -C "$st" meta
`;

/** Inside a fresh sandbox: archive on stdin. Idempotent per generation (marker under /run). */
export const RESTORE_SCRIPT = `set -eu
mkdir ${MARKER} 2>/dev/null || { echo "already restored" >&2; exit 0; }
t=$(mktemp -d /tmp/lrest.XXXXXX)
trap 'rm -rf "$t"' EXIT
tar -xzf - -C "$t" --numeric-owner
[ "$(cat "$t/meta/format" 2>/dev/null)" = "${SNAPSHOT_FORMAT}" ] || { echo "unknown snapshot format" >&2; exit 65; }
mkdir -p /workspace
if [ -d "$t/workspace" ]; then cp -a "$t/workspace/." /workspace/; fi
if [ -d "$t/volumes" ]; then
  i=0; until docker info >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 90 ] || { echo "inner docker not up" >&2; exit 69; }; sleep 1; done
  for d in "$t"/volumes/*/; do
    v=$(basename "$d"); [ -d "$d/_data" ] || continue
    set --
    while IFS= read -r l; do [ -n "$l" ] && set -- "$@" "--label=$l"; done <<EOF2
$(jq -r 'to_entries[]? | "\\(.key)=\\(.value)"' "$t/meta/volumes/$v" 2>/dev/null || true)
EOF2
    docker volume create "$@" "$v" >/dev/null
    dst=$(docker volume inspect -f '{{.Mountpoint}}' "$v")
    cp -a "$d/_data/." "$dst/"
  done
fi
touch ${MARKER}/done
`;

export interface StreamExec {
  /** Run argv in the allocation; stdin from a file, stdout to a file (binary safe). */
  run(
    allocId: string,
    argv: string[],
    io: { stdinPath?: string; stdoutPath?: string; timeoutMs: number },
  ): Promise<{ exitCode: number; stderr: string }>;
}
/** `nomad alloc exec` against the local agent; nothing runs in a host shell. */
export class NomadStreamExec implements StreamExec {
  constructor(
    private readonly bin = "nomad",
    private readonly env: Record<string, string> = {},
  ) {}
  async run(
    allocId: string,
    argv: string[],
    io: { stdinPath?: string; stdoutPath?: string; timeoutMs: number },
  ) {
    const child = spawn(
      this.bin,
      ["alloc", "exec", "-t=false", `-i=${io.stdinPath !== undefined}`, allocId, ...argv],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
        signal: AbortSignal.timeout(io.timeoutMs),
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < 8192) stderr += d;
    });
    const done = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    const out = io.stdoutPath
      ? pipeline(child.stdout, createWriteStream(io.stdoutPath, { mode: 0o600 }))
      : pipeline(child.stdout, new Writable({ write: (_c, _e, cb) => cb() }));
    if (io.stdinPath)
      void pipeline(createReadStream(io.stdinPath), child.stdin).catch(() => undefined);
    else child.stdin.end();
    const [exitCode] = await Promise.all([done, out]);
    return { exitCode, stderr: stderr.trim() };
  }
}

export interface SnapshotStore {
  put(
    key: string,
    path: string,
    meta: Record<string, string>,
  ): Promise<{ size: number; sha256: string }>;
  head(key: string): Promise<{ size: number; meta: Record<string, string> } | null>;
  get(key: string, path: string): Promise<boolean>;
}
export class S3SnapshotStore implements SnapshotStore {
  constructor(private readonly s3: S3Client) {}
  put(key: string, path: string, meta: Record<string, string>) {
    return this.s3.putFile(key, path, meta);
  }
  head(key: string) {
    return this.s3.head(key);
  }
  get(key: string, path: string) {
    return this.s3.getFile(key, path);
  }
}

export const snapshotKey = (workspaceId: string) => {
  if (!/^ws-[a-z0-9]{12,40}$/.test(workspaceId)) throw new Error("invalid workspace id");
  return `sandboxes/${workspaceId}/workspace.tar.gz`;
};

export interface PersistenceOptions {
  /** Largest snapshot accepted (bytes, compressed). Default 2 GiB. */
  maxBytes?: number;
  /** Consecutive failed snapshots before stopping anyway. Default 3. */
  maxFailures?: number;
  saveTimeoutMs?: number;
  restoreTimeoutMs?: number;
  tmpDir?: string;
  log?: (msg: string) => void;
}
interface Hands {
  claimIdle(owner: string, id: string, idleMs: number): Promise<HandsBinding | null>;
  unclaimIdle(owner: string, id: string, generation: number): Promise<unknown>;
  stop(owner: string, id: string): Promise<unknown>;
}
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class S3SandboxSuspender implements SandboxSuspender {
  private readonly failures = new Map<string, number>();
  private readonly log: (m: string) => void;
  constructor(
    private readonly hands: Hands,
    private readonly store: Store,
    private readonly snapshots: SnapshotStore,
    private readonly exec: StreamExec,
    private readonly options: PersistenceOptions = {},
  ) {
    this.log = options.log ?? (() => undefined);
  }
  private note(owner: string, id: string, type: string, data: Record<string, unknown>) {
    return this.store
      .mutate(owner, id, (c) => void append(c, type, data))
      .catch((e) => this.log(`persistence: could not record ${type} (${id}): ${why(e)}`));
  }
  private async scratch() {
    return mkdtemp(join(this.options.tmpDir ?? tmpdir(), "lsnap-"));
  }

  async suspendIfIdle(owner: string, id: string, idleMs: number): Promise<boolean> {
    const b = await this.hands.claimIdle(owner, id, idleMs);
    if (!b) return false;
    try {
      const saved = await this.save(b);
      this.failures.delete(b.workspaceId);
      await this.note(owner, id, "workspace.saved", {
        generation: b.generation,
        bytes: saved.size,
      });
      this.log(`persistence: saved ${b.workspaceId} g${b.generation} (${saved.size} bytes)`);
    } catch (error) {
      const n = (this.failures.get(b.workspaceId) ?? 0) + 1;
      const giveUp = n >= (this.options.maxFailures ?? 3);
      this.log(
        `persistence: save failed ${b.workspaceId} (${n}${giveUp ? ", stopping anyway" : ", will retry"}): ${why(error)}`,
      );
      await this.note(owner, id, "workspace.save_failed", {
        generation: b.generation,
        error: why(error).slice(0, 300),
        stoppedAnyway: giveUp,
      });
      if (!giveUp) {
        this.failures.set(b.workspaceId, n);
        await this.hands.unclaimIdle(owner, id, b.generation);
        return false;
      }
      this.failures.delete(b.workspaceId);
    }
    await this.hands.stop(owner, id);
    return true;
  }

  private async save(b: HandsBinding) {
    if (!b.allocId) throw new Error("no allocation");
    const dir = await this.scratch();
    try {
      const file = join(dir, "snapshot.tar.gz");
      const r = await this.exec.run(b.allocId, ["sh", "-c", SAVE_SCRIPT], {
        stdoutPath: file,
        timeoutMs: this.options.saveTimeoutMs ?? 600_000,
      });
      if (r.exitCode !== 0)
        throw new Error(`snapshot exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
      const { size } = await stat(file);
      if (size === 0) throw new Error("empty snapshot");
      if (size > (this.options.maxBytes ?? 2 * 1024 ** 3))
        throw new Error(`snapshot too large (${size} bytes)`);
      // Whole-stream check: a truncated transfer never replaces a good snapshot.
      await pipeline(
        createReadStream(file),
        createGunzip(),
        new Writable({ write: (_c, _e, cb) => cb() }),
      );
      // This generation started without its saved copy (restore failed): keep that copy as the
      // one to restore and park this session's files beside it instead of overwriting it.
      const failedRestore =
        (await this.exec.run(b.allocId, ["test", "-e", `${MARKER}/failed`], { timeoutMs: 60_000 }))
          .exitCode === 0;
      const key = failedRestore
        ? snapshotKey(b.workspaceId).replace(
            /\.tar\.gz$/,
            `.after-failed-restore-g${b.generation}.tar.gz`,
          )
        : snapshotKey(b.workspaceId);
      return await this.snapshots.put(key, file, {
        format: SNAPSHOT_FORMAT,
        generation: String(b.generation),
        "saved-at": new Date().toISOString(),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** NomadKataHands' afterReady hook. Never throws for a failed restore. */
  async restore(owner: string, id: string, b: HandsBinding): Promise<void> {
    if (!b.allocId) return;
    const quiet = { timeoutMs: 60_000 };
    // Already handled for this generation (e.g. the backend restarted)?
    const seen = await this.exec.run(b.allocId, ["test", "-e", MARKER], quiet);
    if (seen.exitCode === 0) return;
    let dir: string | undefined;
    try {
      const key = snapshotKey(b.workspaceId);
      const head = await this.snapshots.head(key);
      // Nothing saved, or saved by this/a later generation (never roll a live workspace back).
      if (!head || !(Number(head.meta.generation) < b.generation)) {
        await this.exec.run(b.allocId, ["mkdir", "-p", MARKER], quiet);
        return;
      }
      dir = await this.scratch();
      const file = join(dir, "snapshot.tar.gz");
      if (!(await this.snapshots.get(key, file))) throw new Error("snapshot disappeared");
      const r = await this.exec.run(b.allocId, ["sh", "-c", RESTORE_SCRIPT], {
        stdinPath: file,
        timeoutMs: this.options.restoreTimeoutMs ?? 600_000,
      });
      if (r.exitCode !== 0)
        throw new Error(`restore exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
      const { size } = await stat(file);
      await this.note(owner, id, "workspace.restored", {
        generation: b.generation,
        from: Number(head.meta.generation),
        bytes: size,
      });
      this.log(`persistence: restored ${b.workspaceId} into g${b.generation} (${size} bytes)`);
    } catch (error) {
      this.log(`persistence: restore failed ${b.workspaceId} g${b.generation}: ${why(error)}`);
      await this.note(owner, id, "workspace.restore_failed", {
        generation: b.generation,
        error: why(error).slice(0, 300),
      });
      const msg = `# Workspace restore failed\n\nThis sandbox started without the files saved from its previous session (${new Date().toISOString()}).\nThe saved copy is kept; ask the platform operator to retry.\n`;
      await this.writeNote(b.allocId, msg).catch(() => undefined);
      await this.exec
        .run(b.allocId, ["sh", "-c", `mkdir -p ${MARKER} && touch ${MARKER}/failed`], quiet)
        .catch(() => undefined);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
  private async writeNote(allocId: string, text: string) {
    const dir = await this.scratch();
    try {
      const f = join(dir, "note");
      const h = await open(f, "w", 0o600);
      await h.writeFile(text);
      await h.close();
      await this.exec.run(
        allocId,
        ["sh", "-c", "mkdir -p /workspace && cat > /workspace/RESTORE_FAILED.md"],
        {
          stdinPath: f,
          timeoutMs: 30_000,
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
