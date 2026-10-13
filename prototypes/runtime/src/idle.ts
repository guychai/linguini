import type { Store } from "./store.ts";

/**
 * Suspend/resume hook for idle sandboxes. The default implementation stops compute and lets the
 * next tool call start a fresh sandbox (workspace contents are not preserved). A real platform
 * can replace it, e.g. suspend = snapshot part of the sandbox filesystem to S3-compatible storage
 * then stop; resume = restore that snapshot into the new generation before the first tool call.
 */
export interface SandboxSuspender {
  /** Suspend only if still idle (checked atomically); true when it suspended. */
  suspendIfIdle(owner: string, conversationId: string, idleMs: number): Promise<boolean>;
}
export class StopOnIdle implements SandboxSuspender {
  constructor(
    private readonly hands: {
      stopIfIdle(owner: string, id: string, idleMs: number): Promise<boolean>;
    },
  ) {}
  suspendIfIdle(owner: string, id: string, idleMs: number) {
    return this.hands.stopIfIdle(owner, id, idleMs);
  }
}

/** "15m", "30s", "900000" (ms), "0"/"off" = disabled. */
export function parseDuration(v: string | undefined): number {
  if (!v || v === "off") return 0;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(v.trim());
  if (!m) throw new Error(`invalid duration: ${v}`);
  return Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 3.6e6 }[(m[2] ?? "ms") as "ms"];
}

/** Periodically suspends sandboxes of conversations idle for idleMs. */
export class IdleReaper {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(
    private readonly store: Store,
    private readonly owners: () => Iterable<string>,
    private readonly suspender: SandboxSuspender,
    private readonly idleMs: number,
    private readonly log: (msg: string) => void = () => undefined,
    private readonly hooks: {
      /** True while something outside the journal (an attached, active terminal) keeps it alive. */
      keepAlive?(owner: string, conversationId: string, lastActivityMs: number): boolean;
      onSuspended?(owner: string, conversationId: string): void;
    } = {},
  ) {}
  start(intervalMs = Math.min(60_000, Math.max(1_000, Math.floor(this.idleMs / 4)))) {
    if (this.idleMs <= 0) return this;
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref();
    return this;
  }
  stop() {
    clearInterval(this.timer);
  }
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let stopped = 0;
    try {
      for (const owner of this.owners()) {
        let after: string | undefined;
        do {
          const page = await this.store.list(owner, after === undefined ? {} : { after });
          for (const c of page.items) {
            if (c.hands?.state !== "ready") continue;
            const last = Date.parse(c.updatedAt ?? new Date().toISOString());
            if (Date.now() - last < this.idleMs) continue;
            if (this.hooks.keepAlive?.(owner, c.id, last)) continue;
            try {
              if (await this.suspender.suspendIfIdle(owner, c.id, this.idleMs)) {
                stopped++;
                this.hooks.onSuspended?.(owner, c.id);
                this.log(`idle sandbox suspended (${c.id})`);
              }
            } catch (error) {
              this.log(`idle suspend failed (${c.id}): ${String(error)}`);
            }
          }
          after = page.next ?? undefined;
        } while (after !== undefined);
      }
    } finally {
      this.running = false;
    }
    return stopped;
  }
}
