// One live change feed per T3 session. Transient failures are retried a bounded number of
// times inside the session; after that, or immediately on 401/403, the feed fails once and
// the T3 connection supervisor takes over (visible state, backoff, Reconnect action).
export type FeedFailure =
  | { kind: "auth"; status: number; detail: string }
  | { kind: "outage"; attempts: number; detail: string };
export interface LiveFeedOptions {
  url: string;
  fetch: typeof fetch;
  headers: () => Record<string, string>;
  /** Delays between consecutive failed attempts. Its length bounds in-session retries. */
  retryDelaysMs?: readonly number[];
  /** No bytes (including keepalives) for this long means a dead connection. */
  idleTimeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A connection that stayed up this long resets the retry budget. */
  stableAfterMs?: number;
  now?: () => number;
}
export const DEFAULT_RETRY_DELAYS_MS = [250, 1000, 2000] as const;
/** The server sends a keepalive every 15 s. */
export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
export const DEFAULT_STABLE_AFTER_MS = 10_000;
const authStatus = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 401 || status === 403 ? status : undefined;
};
const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export class LiveFeed {
  readonly failed: Promise<FeedFailure>;
  /** Fetch attempts made so far (observable for tests and diagnostics). */
  attempts = 0;
  private fail!: (failure: FeedFailure) => void;
  private done = false;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => Promise<void> | void>();
  private readonly retryDelays: readonly number[];
  private readonly idleTimeoutMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly stableAfterMs: number;
  private readonly now: () => number;
  constructor(private options: LiveFeedOptions) {
    this.failed = new Promise((resolve) => {
      this.fail = (f) => {
        if (this.done) return;
        this.done = true;
        this.controller.abort();
        resolve(f);
      };
    });
    this.retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.stableAfterMs = options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;
    this.now = options.now ?? Date.now;
  }
  get closed() {
    return this.done;
  }
  /** Listeners re-read their snapshot on every change frame. Errors with 401/403 end the feed. */
  subscribe(listener: () => Promise<void> | void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Stop without reporting a failure (session scope closed). */
  close() {
    this.done = true;
    this.controller.abort();
  }
  start() {
    void this.run();
    return this;
  }
  private async notify() {
    await Promise.all([...this.listeners].map(async (l) => l()));
  }
  private async run() {
    let consecutive = 0,
      last = "";
    while (!this.done) {
      const attempt = new AbortController();
      const abort = () => attempt.abort();
      this.controller.signal.addEventListener("abort", abort, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      let connectedAt: number | undefined;
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(
          () => attempt.abort(new Error("Live feed idle timeout")),
          this.idleTimeoutMs,
        );
      };
      try {
        this.attempts++;
        armIdle();
        const response = await this.options.fetch(this.options.url, {
          headers: this.options.headers(),
          signal: attempt.signal,
        });
        if (response.status === 401 || response.status === 403)
          return this.fail({
            kind: "auth",
            status: response.status,
            detail: `Live feed rejected credentials (HTTP ${response.status})`,
          });
        if (!response.ok || !response.body)
          throw new Error(`Live feed returned HTTP ${response.status}`);
        connectedAt = this.now();
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) throw new Error("Live feed closed by the server");
            armIdle();
            buffer += decoder.decode(next.value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (!frame.startsWith("data:")) continue;
              await this.notify();
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      } catch (error) {
        if (this.done) return;
        const status = authStatus(error);
        if (status)
          return this.fail({
            kind: "auth",
            status,
            detail: `Credentials rejected (HTTP ${status})`,
          });
        last =
          attempt.signal.aborted && attempt.signal.reason instanceof Error
            ? attempt.signal.reason.message
            : String(error instanceof Error ? error.message : error);
      } finally {
        clearTimeout(idle);
        this.controller.signal.removeEventListener("abort", abort);
      }
      // Only a connection that stayed up resets the budget, so a server that accepts and
      // immediately drops connections cannot cause an endless retry loop.
      if (connectedAt !== undefined && this.now() - connectedAt >= this.stableAfterMs)
        consecutive = 0;
      consecutive++;
      if (consecutive > this.retryDelays.length)
        return this.fail({
          kind: "outage",
          attempts: consecutive,
          detail: `Live updates unavailable after ${consecutive} attempts: ${last}`,
        });
      await this.sleep(this.retryDelays[consecutive - 1]!, this.controller.signal);
    }
  }
}
