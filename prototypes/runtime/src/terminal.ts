/**
 * Interactive user terminals, run INSIDE the conversation's Kata sandbox.
 *
 * - The PTY lives in the sandbox (Nomad exec with tty); nothing runs on the host and the backend's
 *   environment (model key, DB URL) is never passed: exec inherits only the sandbox task's env.
 * - User-only: Pi has no access; terminal I/O is not in the tool ledger and does not taint.
 *   Only open/close and byte counts are logged, never keystrokes or output.
 * - Scrollback is an in-memory ring buffer per terminal; shells do not survive a backend restart.
 * - Limits: per conversation and per node. Opening provisions the sandbox if needed.
 */
import { ApiError } from "./store.ts";

export interface ExecChannel {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}
export interface ExecHandlers {
  onData(data: string): void;
  onExit(exitCode: number | null, error?: string): void;
}
/** Opens a TTY exec channel into an allocation. */
export interface ExecConnector {
  open(
    allocId: string,
    command: string[],
    size: { cols: number; rows: number },
    handlers: ExecHandlers,
  ): Promise<ExecChannel>;
}
export interface SandboxTarget {
  allocId: string;
  generation: number;
}
export type TerminalStatus = "starting" | "running" | "exited" | "error";
export interface TerminalSnapshot {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: null;
  status: TerminalStatus;
  pid: null;
  history: string;
  exitCode: number | null;
  exitSignal: null;
  label: string;
  updatedAt: string;
  sequence: number;
}
export type TerminalStreamEvent =
  | { type: "snapshot"; snapshot: TerminalSnapshot }
  | { type: "output"; threadId: string; terminalId: string; sequence: number; data: string }
  | {
      type: "exited";
      threadId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: null;
    }
  | { type: "closed"; threadId: string; terminalId: string; sequence: number }
  | { type: "error"; threadId: string; terminalId: string; sequence: number; message: string }
  | { type: "cleared"; threadId: string; terminalId: string; sequence: number }
  | {
      type: "restarted";
      threadId: string;
      terminalId: string;
      sequence: number;
      snapshot: TerminalSnapshot;
    };
export interface TerminalSummary {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: null;
  status: TerminalStatus;
  pid: null;
  exitCode: number | null;
  exitSignal: null;
  hasRunningSubprocess: boolean;
  label: string;
  updatedAt: string;
}
export type MetadataEvent =
  | { type: "snapshot"; terminals: TerminalSummary[] }
  | { type: "upsert"; terminal: TerminalSummary }
  | { type: "remove"; threadId: string; terminalId: string };

export const SHELL_COMMAND = [
  "/bin/sh",
  "-c",
  "cd /workspace 2>/dev/null || cd /; export TERM=xterm-256color; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
];
const TERMINAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface Session {
  owner: string;
  threadId: string;
  terminalId: string;
  status: TerminalStatus;
  history: string;
  sequence: number;
  exitCode: number | null;
  channel?: ExecChannel;
  generation?: number;
  cols: number;
  rows: number;
  updatedAt: string;
  openedAt: number;
  bytesIn: number;
  bytesOut: number;
  listeners: Set<(e: TerminalStreamEvent) => void>;
  starting?: Promise<void>;
}
export interface TerminalManagerOptions {
  /** Provision (if needed) the conversation's sandbox, apply its egress policy, return the alloc. */
  prepare(owner: string, conversationId: string): Promise<SandboxTarget>;
  connector: ExecConnector;
  perConversation?: number;
  perNode?: number;
  historyBytes?: number;
  log?: (message: string) => void;
  now?: () => number;
}

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private metadataListeners = new Map<string, Set<(e: MetadataEvent) => void>>();
  private eventListeners = new Map<string, Set<(e: TerminalStreamEvent) => void>>();
  /** Last input/resize/attach activity per conversation (ms), for the idle reaper. */
  private activity = new Map<string, number>();
  private readonly perConversation: number;
  private readonly perNode: number;
  private readonly historyBytes: number;
  private readonly now: () => number;
  constructor(private readonly options: TerminalManagerOptions) {
    this.perConversation = options.perConversation ?? 4;
    this.perNode = options.perNode ?? 16;
    this.historyBytes = options.historyBytes ?? 256 * 1024;
    this.now = options.now ?? Date.now;
  }
  private key(owner: string, threadId: string, terminalId: string) {
    return JSON.stringify([owner, threadId, terminalId]);
  }
  private convKey(owner: string, threadId: string) {
    return JSON.stringify([owner, threadId]);
  }
  private log(message: string) {
    this.options.log?.(message);
  }
  private touch(s: Session) {
    s.updatedAt = new Date(this.now()).toISOString();
  }
  private markActive(owner: string, threadId: string) {
    this.activity.set(this.convKey(owner, threadId), this.now());
  }
  snapshot(s: Session): TerminalSnapshot {
    return {
      threadId: s.threadId,
      terminalId: s.terminalId,
      cwd: "/workspace",
      worktreePath: null,
      status: s.status,
      pid: null,
      history: s.history,
      exitCode: s.exitCode,
      exitSignal: null,
      label: s.status === "running" ? "shell" : s.status,
      updatedAt: s.updatedAt,
      sequence: s.sequence,
    };
  }
  private summary(s: Session): TerminalSummary {
    const { history: _h, sequence: _q, ...rest } = this.snapshot(s);
    return { ...rest, hasRunningSubprocess: false };
  }
  private emit(s: Session, event: TerminalStreamEvent) {
    for (const l of s.listeners) l(event);
    if (event.type !== "snapshot") for (const l of this.eventListeners.get(s.owner) ?? []) l(event);
  }
  private emitMeta(owner: string, event: MetadataEvent) {
    for (const l of this.metadataListeners.get(owner) ?? []) l(event);
  }
  private get(owner: string, threadId: string, terminalId: string) {
    const s = this.sessions.get(this.key(owner, threadId, terminalId));
    if (!s) throw new ApiError(404, "Terminal not found", "terminal_not_found");
    return s;
  }
  private appendHistory(s: Session, data: string) {
    s.history += data;
    if (s.history.length > this.historyBytes) s.history = s.history.slice(-this.historyBytes);
  }

  /** Open (or return the running) terminal. Provisions the sandbox when needed. */
  async open(
    owner: string,
    threadId: string,
    terminalId: string,
    size: { cols?: number; rows?: number } = {},
  ): Promise<TerminalSnapshot> {
    if (!TERMINAL_ID.test(terminalId)) throw new ApiError(400, "Invalid terminal ID");
    const k = this.key(owner, threadId, terminalId);
    let s = this.sessions.get(k);
    if (!s) {
      const inConversation = [...this.sessions.values()].filter(
        (x) => x.owner === owner && x.threadId === threadId,
      ).length;
      if (inConversation >= this.perConversation)
        throw new ApiError(
          429,
          `At most ${this.perConversation} terminals per conversation`,
          "terminal_limit_conversation",
        );
      if (this.sessions.size >= this.perNode)
        throw new ApiError(
          429,
          `At most ${this.perNode} terminals on this node`,
          "terminal_limit_node",
        );
      s = {
        owner,
        threadId,
        terminalId,
        status: "starting",
        history: "",
        sequence: 0,
        exitCode: null,
        cols: clamp(size.cols, 20, 400, 120),
        rows: clamp(size.rows, 5, 200, 30),
        updatedAt: new Date(this.now()).toISOString(),
        openedAt: this.now(),
        bytesIn: 0,
        bytesOut: 0,
        listeners: new Set(),
      };
      this.sessions.set(k, s);
    }
    this.markActive(owner, threadId);
    if (s.status === "running" || s.starting) {
      await s.starting;
      return this.snapshot(s);
    }
    await this.start(s);
    return this.snapshot(s);
  }
  private start(s: Session): Promise<void> {
    s.status = "starting";
    s.exitCode = null;
    this.touch(s);
    this.emitMeta(s.owner, { type: "upsert", terminal: this.summary(s) });
    const run = (async () => {
      try {
        const target = await this.options.prepare(s.owner, s.threadId);
        s.generation = target.generation;
        let channel: ExecChannel | undefined;
        channel = await this.options.connector.open(
          target.allocId,
          SHELL_COMMAND,
          { cols: s.cols, rows: s.rows },
          {
            onData: (data) => {
              if (s.channel !== channel) return;
              s.bytesOut += data.length;
              this.appendHistory(s, data);
              s.sequence++;
              this.touch(s);
              this.emit(s, {
                type: "output",
                threadId: s.threadId,
                terminalId: s.terminalId,
                sequence: s.sequence,
                data,
              });
            },
            onExit: (exitCode, error) => {
              if (s.channel !== channel) return;
              s.channel = undefined;
              s.status = error ? "error" : "exited";
              s.exitCode = exitCode;
              s.sequence++;
              this.touch(s);
              const note = error
                ? `\r\n[terminal error: ${error}]\r\n`
                : `\r\n[process exited${exitCode === null ? "" : ` with code ${exitCode}`}]\r\n`;
              this.appendHistory(s, note);
              this.emit(
                s,
                error
                  ? {
                      type: "error",
                      threadId: s.threadId,
                      terminalId: s.terminalId,
                      sequence: s.sequence,
                      message: error,
                    }
                  : {
                      type: "exited",
                      threadId: s.threadId,
                      terminalId: s.terminalId,
                      sequence: s.sequence,
                      exitCode,
                      exitSignal: null,
                    },
              );
              this.emitMeta(s.owner, { type: "upsert", terminal: this.summary(s) });
              this.log(
                `terminal exited (${s.threadId}/${s.terminalId}, in=${s.bytesIn}B out=${s.bytesOut}B)`,
              );
            },
          },
        );
        s.channel = channel;
        s.status = "running";
        this.touch(s);
        this.log(`terminal opened (${s.threadId}/${s.terminalId})`);
        this.emitMeta(s.owner, { type: "upsert", terminal: this.summary(s) });
      } catch (error) {
        s.status = "error";
        s.sequence++;
        const message = error instanceof Error ? error.message : String(error);
        this.appendHistory(s, `\r\n[terminal could not start: ${message}]\r\n`);
        this.touch(s);
        this.emit(s, {
          type: "error",
          threadId: s.threadId,
          terminalId: s.terminalId,
          sequence: s.sequence,
          message,
        });
        this.emitMeta(s.owner, { type: "upsert", terminal: this.summary(s) });
        throw error;
      } finally {
        s.starting = undefined;
      }
    })();
    s.starting = run.catch(() => undefined);
    return run;
  }
  /** Stream for one terminal: a snapshot, then live events. Optionally (re)starts it. */
  async attach(
    owner: string,
    threadId: string,
    terminalId: string,
    listener: (e: TerminalStreamEvent) => void,
    options: { open?: boolean; cols?: number; rows?: number; restartIfNotRunning?: boolean } = {},
  ): Promise<() => void> {
    let s = this.sessions.get(this.key(owner, threadId, terminalId));
    if (!s && options.open) {
      let failure: unknown;
      await this.open(owner, threadId, terminalId, options).catch((e) => (failure = e));
      s = this.sessions.get(this.key(owner, threadId, terminalId));
      if (!s && failure) {
        // E.g. the terminal limit: show why in the pane instead of a blank terminal.
        const message = failure instanceof Error ? failure.message : String(failure);
        listener({
          type: "snapshot",
          snapshot: {
            threadId,
            terminalId,
            cwd: "/workspace",
            worktreePath: null,
            status: "error",
            pid: null,
            history: `[terminal not started: ${message}]\r\n`,
            exitCode: null,
            exitSignal: null,
            label: "error",
            updatedAt: new Date(this.now()).toISOString(),
            sequence: 0,
          },
        });
        return () => undefined;
      }
    }
    if (!s) throw new ApiError(404, "Terminal not found", "terminal_not_found");
    if (
      options.restartIfNotRunning &&
      (s.status === "exited" || s.status === "error") &&
      !s.starting
    )
      void this.start(s).catch(() => undefined);
    const session = s;
    listener({ type: "snapshot", snapshot: this.snapshot(session) });
    session.listeners.add(listener);
    this.markActive(owner, threadId);
    return () => {
      session.listeners.delete(listener);
    };
  }
  write(owner: string, threadId: string, terminalId: string, data: string) {
    const s = this.get(owner, threadId, terminalId);
    if (!s.channel || s.status !== "running")
      throw new ApiError(409, "Terminal is not running", "terminal_not_running");
    if (data.length > 65_536) throw new ApiError(413, "Write too large");
    s.bytesIn += data.length;
    s.channel.write(data);
    this.markActive(owner, threadId);
  }
  resize(owner: string, threadId: string, terminalId: string, cols: number, rows: number) {
    const s = this.get(owner, threadId, terminalId);
    s.cols = clamp(cols, 20, 400, s.cols);
    s.rows = clamp(rows, 5, 200, s.rows);
    s.channel?.resize(s.cols, s.rows);
    this.markActive(owner, threadId);
  }
  clear(owner: string, threadId: string, terminalId: string) {
    const s = this.get(owner, threadId, terminalId);
    s.history = "";
    s.sequence++;
    this.touch(s);
    this.emit(s, { type: "cleared", threadId, terminalId, sequence: s.sequence });
  }
  async restart(
    owner: string,
    threadId: string,
    terminalId: string,
    size: { cols?: number; rows?: number } = {},
  ) {
    let s = this.sessions.get(this.key(owner, threadId, terminalId));
    if (!s) return this.open(owner, threadId, terminalId, size);
    if (s.channel) {
      const old = s.channel;
      s.channel = undefined;
      old.close();
    }
    s.history = "";
    if (size.cols) s.cols = clamp(size.cols, 20, 400, s.cols);
    if (size.rows) s.rows = clamp(size.rows, 5, 200, s.rows);
    await this.start(s);
    s.sequence++;
    this.emit(s, {
      type: "restarted",
      threadId,
      terminalId,
      sequence: s.sequence,
      snapshot: this.snapshot(s),
    });
    return this.snapshot(s);
  }
  close(owner: string, threadId: string, terminalId?: string) {
    for (const s of [...this.sessions.values()]) {
      if (s.owner !== owner || s.threadId !== threadId) continue;
      if (terminalId && s.terminalId !== terminalId) continue;
      const channel = s.channel;
      s.channel = undefined;
      channel?.close();
      s.sequence++;
      this.emit(s, { type: "closed", threadId, terminalId: s.terminalId, sequence: s.sequence });
      s.listeners.clear();
      this.sessions.delete(this.key(owner, threadId, s.terminalId));
      this.emitMeta(owner, { type: "remove", threadId, terminalId: s.terminalId });
      this.log(
        `terminal closed (${threadId}/${s.terminalId}, in=${s.bytesIn}B out=${s.bytesOut}B)`,
      );
    }
  }
  /** Sandbox stopped (idle or replaced): end every shell of the conversation, keep scrollback. */
  sandboxStopped(owner: string, threadId: string) {
    for (const s of this.sessions.values())
      if (s.owner === owner && s.threadId === threadId && s.channel) {
        const channel = s.channel;
        channel.close();
        s.channel = undefined;
        s.status = "exited";
        s.sequence++;
        this.appendHistory(s, "\r\n[sandbox stopped]\r\n");
        this.emit(s, {
          type: "exited",
          threadId,
          terminalId: s.terminalId,
          sequence: s.sequence,
          exitCode: null,
          exitSignal: null,
        });
        this.emitMeta(owner, { type: "upsert", terminal: this.summary(s) });
      }
  }
  subscribeMetadata(owner: string, listener: (e: MetadataEvent) => void) {
    const set = this.metadataListeners.get(owner) ?? new Set();
    this.metadataListeners.set(owner, set);
    listener({
      type: "snapshot",
      terminals: [...this.sessions.values()]
        .filter((s) => s.owner === owner)
        .map((s) => this.summary(s)),
    });
    set.add(listener);
    return () => set.delete(listener);
  }
  subscribeEvents(owner: string, listener: (e: TerminalStreamEvent) => void) {
    const set = this.eventListeners.get(owner) ?? new Set();
    this.eventListeners.set(owner, set);
    set.add(listener);
    return () => set.delete(listener);
  }
  /**
   * Keep-alive for the idle reaper: a running terminal that is attached in a browser and was used
   * within `recentMs` keeps the sandbox, but never longer than `capMs` past the conversation's
   * last non-terminal activity.
   */
  keepsAlive(
    owner: string,
    threadId: string,
    conversationActivityMs: number,
    recentMs: number,
    capMs: number,
  ) {
    const attachedRunning = [...this.sessions.values()].some(
      (s) =>
        s.owner === owner &&
        s.threadId === threadId &&
        s.status === "running" &&
        s.listeners.size > 0,
    );
    if (!attachedRunning) return false;
    const last = this.activity.get(this.convKey(owner, threadId)) ?? 0;
    const now = this.now();
    return now - last < recentMs && now - conversationActivityMs < capMs;
  }
  count() {
    return this.sessions.size;
  }
  closeAll() {
    for (const s of [...this.sessions.values()]) this.close(s.owner, s.threadId, s.terminalId);
  }
}
function clamp(v: number | undefined, min: number, max: number, fallback: number) {
  return typeof v === "number" && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
