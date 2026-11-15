import { userEditNote } from "./files.ts";
import { clearOnMessage } from "./settlement.ts";
import { recordPiOutcome, recoverPiState } from "./pi-state.ts";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  ApiError,
  StaleOwnerError,
  append,
  assertFence,
  dbNow,
  listAll,
  read,
  type Conversation,
  type Fence,
  type Store,
} from "./store.ts";
import { assertPublicationAllowed, fingerprint } from "./sandbox.ts";
import { assertNotBlocked, reconcileOnAcquire, resolveUnknown, unresolved } from "./ledger.ts";
import type { Harness, HarnessFactory } from "./harness.ts";

export interface Command {
  commandId: string;
  kind:
    | "prompt"
    | "queue"
    | "steer"
    | "cancel"
    | "create_pr"
    | "publish"
    | "queue_cancel"
    | "queue_edit"
    | "queue_reorder";
  jobId?: string;
  beforeJobId?: string | null;
  text?: string;
  messageId?: string;
  /** For `steer`: the run the client intends to steer. A different or finished run is a conflict. */
  targetJobId?: string;
}
/** Typed conflict codes returned to clients (HTTP 409 `code`) and recorded on rejected steering. */
export const STEER_TARGET_NOT_ACTIVE = "STEER_TARGET_NOT_ACTIVE";
export const STEER_TARGET_FINISHED = "STEER_TARGET_FINISHED";
export const STEER_TARGET_RECOVERED = "STEER_TARGET_RECOVERED";
type SteerRejection =
  | typeof STEER_TARGET_FINISHED
  | typeof STEER_TARGET_RECOVERED
  | typeof STEER_TARGET_NOT_ACTIVE;
/**
 * Steering is only ever applied to the run it targeted. Steering that can no longer reach
 * that run (finished, interrupted, recovered after restart) is rejected; it never starts
 * a new run. Clients may offer to send the text as a new message.
 */
/**
 * Steering the harness already consumed (harness.steer returned) but whose confirmation write
 * has not landed yet was delivered: record it as accepted instead of rejecting it, so the UI
 * never offers to resend text the model already received.
 */
function acceptDelivered(c: Conversation, delivered: ReadonlySet<string>, target: string) {
  for (const steer of c.jobs)
    if (steer.kind === "steer" && steer.status === "running" && delivered.has(steer.id)) {
      steer.status = "done";
      append(c, "steering.accepted", { jobId: steer.id, target });
    }
}
function rejectSteers(c: Conversation, reason: SteerRejection, target?: string) {
  for (const steer of c.jobs)
    if (
      steer.kind === "steer" &&
      (steer.status === "queued" || steer.status === "running") &&
      (target === undefined
        ? !c.jobs.some((t) => t.id === steer.target && t.status === "running")
        : steer.target === target)
    ) {
      steer.status = "rejected";
      append(c, "steering.rejected", {
        jobId: steer.id,
        target: steer.target ?? null,
        code: reason,
        text: steer.text,
      });
    }
}
export interface EngineOptions {
  /** Test seam: runs after a job is durably claimed, before the harness exists. */
  afterClaim?: () => Promise<void>;
  /** Stable identity of this worker process; must be unique among live workers. */
  worker?: string;
  /** Lease duration. A worker that cannot renew within this window loses ownership. */
  leaseMs?: number;
  /** Renewal and cross-worker cancel/steer polling interval; `0` disables the timer (tests drive `heartbeat`). */
  heartbeatMs?: number;
  /**
   * After Stop (or lost ownership) aborts a run, how long to wait for the harness to unwind
   * before abandoning it. A provider stream that ignores abort must not block the conversation.
   */
  abortGraceMs?: number;
  /**
   * Tool-ledger recovery, run once after each new lease and before any job: re-sends the
   * previous epoch's interrupted safe reads and idempotent writes (SandboxBroker.recover).
   */
  recoverTools?: (owner: string, id: string, fence: Fence) => Promise<unknown>;
}
/** The run was aborted and its harness did not unwind within the grace period. */
class AbandonedRunError extends Error {
  constructor() {
    super("Harness did not stop after abort; run abandoned");
  }
}
interface Active {
  controller: AbortController;
  ready: Promise<Harness>;
  jobId: string;
  fence: Fence;
  /** Steering IDs whose harness.steer call returned (delivered, confirmation may be pending). */
  delivered: Set<string>;
}
export class Engine {
  readonly changes = new EventEmitter();
  readonly worker: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly abortGraceMs: number;
  private active = new Map<string, Active>();
  private leases = new Map<string, Fence>();
  private workers = new Map<string, Promise<boolean>>();
  private stopped = false;
  private readonly onCommit = (owner: string, id: string) => {
    this.notify(owner, id);
    // Commands may land on another worker; react to cancellations and steering promptly.
    if (this.active.has(this.key(owner, id))) void this.poke(owner, id).catch(() => undefined);
  };
  constructor(
    readonly store: Store,
    private factory: HarnessFactory,
    private hooks: EngineOptions = {},
  ) {
    this.changes.setMaxListeners(0);
    this.worker = hooks.worker ?? `worker-${randomUUID()}`;
    this.leaseMs = hooks.leaseMs ?? 30_000;
    this.heartbeatMs = hooks.heartbeatMs ?? Math.max(1, Math.floor(this.leaseMs / 3));
    this.abortGraceMs = hooks.abortGraceMs ?? 5_000;
    store.changes?.on("commit", this.onCommit);
  }
  private key(owner: string, id: string) {
    return JSON.stringify([owner, id]);
  }
  /**
   * Await harness work, but once `signal` aborts give it only `abortGraceMs` to settle.
   * An abandoned run cannot write: emits check the job is still running, tools check the
   * aborted signal before dispatch, and the harness is disposed.
   */
  private bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    void work.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        timer = setTimeout(() => reject(new AbandonedRunError()), this.abortGraceMs);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
    });
  }
  private notify(owner: string, id: string) {
    this.changes.emit(this.key(owner, id));
  }
  /** Every write made on behalf of a run is checked against the lease in the same transaction. */
  private fenced<T>(
    owner: string,
    id: string,
    fence: Fence,
    f: (c: Conversation) => T,
    events = false,
  ) {
    return this.store.mutate(
      owner,
      id,
      (c) => {
        assertFence(c, fence);
        return f(c);
      },
      { events },
    );
  }
  async command(owner: string, id: string, command: Command) {
    if (
      !command.commandId ||
      command.commandId.length > 200 ||
      ![
        "prompt",
        "queue",
        "steer",
        "cancel",
        "create_pr",
        "publish",
        "queue_cancel",
        "queue_edit",
        "queue_reorder",
      ].includes(command.kind)
    )
      throw new ApiError(400, "Invalid command");
    if (
      ["prompt", "queue", "steer", "queue_edit"].includes(command.kind) &&
      (typeof command.text !== "string" || !command.text.trim() || command.text.length > 100_000)
    )
      throw new ApiError(400, "Invalid prompt");
    const receipt = await this.store.mutate(owner, id, (c) => {
      const hash = fingerprint(command),
        key = `cmd:${command.commandId}`,
        previous = c.receipts[key];
      if (previous) {
        if (previous.fingerprint !== hash)
          throw new ApiError(409, "Command ID reused with a different payload");
        return { value: previous.result as { accepted: true; jobId: string | null }, fresh: false };
      }
      if (["create_pr", "publish"].includes(command.kind)) {
        // Publication is declared egress to a publication destination; an unknown tool
        // outcome also blocks it, since the workspace state is uncertain.
        assertNotBlocked(c);
        assertPublicationAllowed(c);
        // Not implemented: no PR or publish integration exists yet. Pull requests are planned as a
        // host-side GitHub App tool (git-via-egress phase 2); this stub keeps the taint checks above.
        throw new ApiError(
          501,
          "Not implemented: pull requests and publishing are not available yet",
          "not_implemented",
        );
      }
      let jobId: string | null = null;
      if (command.kind.startsWith("queue_")) {
        const index = c.jobs.findIndex((j) => j.id === command.jobId),
          job = c.jobs[index];
        if (!job || job.status !== "queued")
          throw new ApiError(409, "Only queued prompts can be changed");
        if (command.kind === "queue_cancel") {
          job.status = "cancelled";
          append(c, "run.cancelled", { jobId: job.id });
        }
        if (command.kind === "queue_edit") {
          job.text = command.text!;
          append(c, "message.edited", { jobId: job.id, text: job.text });
        }
        if (command.kind === "queue_reorder") {
          const before =
            command.beforeJobId == null
              ? null
              : c.jobs.find((j) => j.id === command.beforeJobId && j.status === "queued");
          if (command.beforeJobId != null && (!before || before === job))
            throw new ApiError(400, "Invalid queue destination");
          c.jobs.splice(index, 1);
          c.jobs.splice(before ? c.jobs.indexOf(before) : c.jobs.length, 0, job);
          append(c, "run.queue.reordered", {
            jobId: job.id,
            beforeJobId: command.beforeJobId ?? null,
          });
        }
      } else if (command.kind === "cancel") {
        for (const job of c.jobs)
          if (job.status === "running" || job.status === "queued") {
            job.status = "cancelled";
            recordPiOutcome(c, job.id, "cancelled");
            append(c, "run.cancelled", { jobId: job.id });
          }
      } else {
        const running = c.jobs.find((j) => j.status === "running" && j.kind !== "steer");
        if (command.kind === "steer" && !running)
          throw new ApiError(
            409,
            "No running turn to steer; send it as a new message instead",
            STEER_TARGET_NOT_ACTIVE,
          );
        if (
          command.kind === "steer" &&
          command.targetJobId !== undefined &&
          command.targetJobId !== running!.id
        )
          throw new ApiError(
            409,
            "The run this steer targets is no longer active; send it as a new message instead",
            STEER_TARGET_NOT_ACTIVE,
          );
        jobId = command.commandId;
        c.jobs.push({
          id: jobId,
          messageId: command.messageId,
          text: command.text!,
          status: "queued",
          kind: command.kind === "steer" ? "steer" : "prompt",
          ...(running && command.kind === "steer" ? { target: running.id } : {}),
        });
        append(c, "message.user", { jobId, text: command.text!, kind: command.kind });
        if (clearOnMessage(c.metadata, new Date().toISOString()))
          append(c, "metadata.updated", { ...c.metadata });
        append(c, "run.queued", { jobId, kind: command.kind });
      }
      const accepted = { accepted: true as const, jobId };
      c.receipts[key] = { fingerprint: hash, result: accepted };
      return { value: accepted, fresh: true };
    });
    const result = receipt.value;
    if (!receipt.fresh) return result;
    this.notify(owner, id);
    if (command.kind === "cancel") {
      const active = this.active.get(this.key(owner, id));
      active?.controller.abort();
      if (active) void active.ready.then((h) => h.abort()).catch(() => undefined);
    } else if (command.kind === "steer") {
      void this.deliverSteering(owner, id, command.commandId).catch(() => undefined);
    } else this.schedule(owner, id);
    return result;
  }
  private async deliverSteering(owner: string, id: string, jobId: string) {
    const active = this.active.get(this.key(owner, id));
    if (!active) return; // the lease holder delivers it (heartbeat or change notification)
    const harness = await active.ready;
    const c = await read(this.store, owner, id),
      job = c.jobs.find((j) => j.id === jobId);
    if (
      !job ||
      job.status !== "queued" ||
      job.target !== active.jobId ||
      active.controller.signal.aborted
    )
      return;
    // Reserve before delivering: a crash must not duplicate a steering command.
    const claimed = await this.fenced(owner, id, active.fence, (c) => {
      const job = c.jobs.find((j) => j.id === jobId)!;
      if (job.status !== "queued") return false;
      job.status = "running";
      return true;
    });
    if (!claimed) return;
    try {
      await harness.steer(job.text);
      active.delivered.add(jobId);
      await this.fenced(owner, id, active.fence, (c) => {
        const j = c.jobs.find((j) => j.id === jobId)!;
        if (j.status === "running") {
          j.status = "done";
          append(c, "steering.accepted", { jobId, target: active.jobId });
        }
      });
    } catch (error) {
      if (error instanceof StaleOwnerError) throw error;
      await this.fenced(owner, id, active.fence, (c) => {
        const j = c.jobs.find((j) => j.id === jobId)!;
        if (j.status === "running") {
          j.status = "interrupted";
          append(c, "steering.interrupted", { jobId });
        }
      });
    }
    this.notify(owner, id);
  }
  /** Check the durable state of the active run: cross-worker cancellation and pending steering. */
  private async poke(owner: string, id: string) {
    const active = this.active.get(this.key(owner, id));
    if (!active || active.jobId === "claiming") return;
    const c = await this.store.snapshot(owner, id, { events: false });
    if (c.jobs.find((j) => j.id === active.jobId)?.status !== "running") {
      this.abortActive(active);
      return;
    }
    for (const steer of c.jobs)
      if (steer.kind === "steer" && steer.status === "queued" && steer.target === active.jobId)
        await this.deliverSteering(owner, id, steer.id);
  }
  private abortActive(active: Active) {
    active.controller.abort();
    void active.ready.then((h) => h.abort()).catch(() => undefined);
  }
  /** Renew the lease for one conversation now. Returns false when ownership was lost. */
  async heartbeat(owner: string, id: string): Promise<boolean> {
    const key = this.key(owner, id),
      fence = this.leases.get(key);
    if (!fence) return false;
    try {
      await this.fenced(owner, id, fence, (c) => {
        // Database clock: worker clock skew can neither shorten nor stretch the lease.
        c.lease = { ...c.lease!, until: dbNow(c) + this.leaseMs };
      });
    } catch (error) {
      if (!(error instanceof StaleOwnerError)) return true; // transient; the lease may still be valid
      this.leases.delete(key);
      const active = this.active.get(key);
      if (active) this.abortActive(active);
      return false;
    }
    await this.poke(owner, id).catch(() => undefined);
    return true;
  }
  /** Take the conversation lease if it is free or expired, bumping the epoch, and recover leftovers. */
  private async acquire(owner: string, id: string): Promise<Fence | null> {
    // A live lease held by another worker is never stolen. A lease recorded under this
    // worker's own identity that this process does not hold belongs to a previous
    // incarnation of the same worker slot (crash + restart), so it is reclaimed at once.
    const restarted = (c: Conversation) =>
      c.lease?.worker === this.worker && !this.leases.has(this.key(owner, id));
    const fence = await this.store.mutate(
      owner,
      id,
      (c) => {
        const now = dbNow(c);
        if (c.lease && c.lease.until > now && !restarted(c)) return null;
        const takeover = !!c.lease && !restarted(c);
        c.epoch = (c.epoch ?? 0) + 1;
        c.lease = { worker: this.worker, epoch: c.epoch, until: now + this.leaseMs };
        // Interrupted non-idempotent tool calls become unknown and block further work.
        reconcileOnAcquire(c, c.epoch);
        // Anything still marked running belonged to a previous owner that is gone.
        recoverPiState(c);
        for (const job of c.jobs) {
          if (job.status === "running") {
            job.status = "interrupted";
            append(c, "run.interrupted", {
              jobId: job.id,
              reason: takeover
                ? "Previous worker lost its lease; unknown side effects are not replayed"
                : "Worker restart; unknown side effects are not replayed",
            });
          }
        }
        // Steering queued for a run that did not survive is never turned into a new run.
        rejectSteers(c, STEER_TARGET_RECOVERED);
        return { worker: this.worker, epoch: c.epoch };
      },
      { events: true },
    );
    if (fence) this.leases.set(this.key(owner, id), fence);
    return fence;
  }
  private schedule(owner: string, id: string) {
    const key = this.key(owner, id);
    if (this.workers.has(key) || this.stopped) return;
    const worker = this.pump(owner, id);
    this.workers.set(key, worker);
    void worker
      .catch(() => false)
      .then((again) => {
        this.workers.delete(key);
        if (again && !this.stopped)
          void read(this.store, owner, id)
            .then((c) => {
              if (c.jobs.some((j) => j.status === "queued")) this.schedule(owner, id);
            })
            .catch(() => undefined);
      });
  }
  /** Runs queued jobs while holding the lease. Returns true when it released the lease normally. */
  private async pump(owner: string, id: string): Promise<boolean> {
    const key = this.key(owner, id);
    const fence = await this.acquire(owner, id);
    if (!fence) return false;
    const timer =
      this.heartbeatMs > 0
        ? setInterval(() => void this.heartbeat(owner, id), this.heartbeatMs)
        : undefined;
    let released = false;
    try {
      await this.hooks.recoverTools?.(owner, id, fence);
      while (!this.stopped && this.leases.get(key) === fence) {
        released = await this.runNext(owner, id, fence);
        if (released) return true;
      }
      return false;
    } catch (error) {
      if (error instanceof StaleOwnerError) return false;
      throw error;
    } finally {
      clearInterval(timer);
      if (this.leases.get(key) === fence) this.leases.delete(key);
      if (!released)
        await this.fenced(owner, id, fence, (c) => {
          c.lease = null;
        }).catch(() => undefined);
    }
  }
  /** Claims and runs one job. Returns true when no job was runnable and the lease was released. */
  private async runNext(owner: string, id: string, fence: Fence): Promise<boolean> {
    const key = this.key(owner, id);
    const controller = new AbortController();
    let resolveHarness!: (h: Harness) => void;
    let rejectHarness!: (error: unknown) => void;
    const ready = new Promise<Harness>((resolve, reject) => {
      resolveHarness = resolve;
      rejectHarness = reject;
    });
    void ready.catch(() => undefined);
    // Register cancellation BEFORE durable claiming, including the claim/registration race.
    const active: Active = {
      controller,
      ready,
      jobId: "claiming",
      fence,
      delivered: new Set(),
    };
    this.active.set(key, active);
    let job: Conversation["jobs"][number] | null;
    try {
      job = await this.fenced(owner, id, fence, (c) => {
        rejectSteers(c, STEER_TARGET_FINISHED);
        const next = c.jobs.find((j) => j.status === "queued" && j.kind !== "steer");
        const blocked = unresolved(c).map((e) => e.execId);
        if (next && blocked.length && String(next.blockedOn) !== String(blocked)) {
          next.blockedOn = blocked;
          append(c, "run.blocked", {
            jobId: next.id,
            reason: "A tool outcome is unknown; resolve it before more work runs",
            execIds: blocked,
          });
        }
        // Releasing in the same transaction that found no work closes the lost-wakeup window.
        if (!next || blocked.length) {
          c.lease = null;
          return null;
        }
        next.status = "running";
        delete next.blockedOn;
        return structuredClone(next);
      });
    } catch (error) {
      rejectHarness(error);
      this.active.delete(key);
      throw error;
    }
    if (!job) {
      rejectHarness(new Error("No runnable job"));
      this.active.delete(key);
      return true;
    }
    active.jobId = job.id;
    await this.hooks.afterClaim?.();
    const claimed = await read(this.store, owner, id);
    if (
      controller.signal.aborted ||
      claimed.jobs.find((j) => j.id === job.id)?.status !== "running"
    ) {
      rejectHarness(new Error("Cancelled before harness creation"));
      this.active.delete(key);
      return false;
    }
    // No await between the last cancellation check and factory registration.
    this.factory(owner, id, job.id, fence).then(resolveHarness, rejectHarness);
    let output = "";
    const emit = async (type: string, data: Record<string, unknown>) => {
      await this.fenced(owner, id, fence, (c) => {
        if (c.jobs.find((j) => j.id === job.id)?.status !== "running" || this.stopped) return;
        if (type === "assistant.delta") output += String(data.text ?? "");
        append(c, type, { ...data, jobId: job.id });
      });
      this.notify(owner, id);
    };
    let harness: Harness | undefined;
    let stale = false;
    try {
      harness = await this.bounded(ready, controller.signal).catch((error) => {
        // A harness that arrives after abandonment is disposed, never run.
        if (error instanceof AbandonedRunError)
          void ready.then(
            (late) => late.dispose(),
            () => {},
          );
        throw error;
      });
      await emit("run.started", { harness: harness.constructor.name });
      // Files the user saved in the Files panel since Pi's last turn: told to Pi as context on
      // this prompt only (the visible transcript comes from message.user, which is unchanged).
      const edits = await this.fenced(owner, id, fence, (c) => {
        const list = c.userEdits ?? [];
        if (list.length) delete c.userEdits;
        return list;
      });
      const prompt = edits.length ? `${userEditNote(edits)}\n\n${job.text}` : job.text;
      await this.bounded(harness.run(prompt, "", emit, controller.signal), controller.signal);
      await this.fenced(owner, id, fence, (c) => {
        const current = c.jobs.find((j) => j.id === job.id)!;
        if (current.status === "running" && !this.stopped) {
          current.status = "done";
          recordPiOutcome(c, job.id, "done");
          append(c, "assistant.completed", { jobId: job.id, text: output });
          append(c, "run.completed", { jobId: job.id });
        }
        // Steering that arrived at (or was mid-delivery during) the final boundary is rejected.
        acceptDelivered(c, active.delivered, job.id);
        rejectSteers(c, STEER_TARGET_FINISHED, job.id);
      });
    } catch (error) {
      stale = error instanceof StaleOwnerError;
      if (!this.stopped && !stale)
        await this.fenced(owner, id, fence, (c) => {
          const current = c.jobs.find((j) => j.id === job.id)!;
          if (current.status === "running") {
            current.status = "interrupted";
            append(c, "run.interrupted", {
              jobId: job.id,
              reason: "Harness failed; inspect configuration and resume explicitly",
            });
          }
          acceptDelivered(c, active.delivered, job.id);
          rejectSteers(c, STEER_TARGET_FINISHED, job.id);
        });
    } finally {
      harness?.dispose();
      this.active.delete(key);
      if (!stale)
        await this.fenced(owner, id, fence, (c) => {
          const current = c.jobs.find((j) => j.id === job.id);
          if (current && !this.stopped) recordPiOutcome(c, job.id, current.status);
        }).catch((error) => {
          if (!(error instanceof StaleOwnerError)) throw error;
          stale = true;
        });
      this.notify(owner, id);
    }
    if (stale) throw new StaleOwnerError();
    return false;
  }
  /** Schedule every conversation; the lease holder recovers interrupted work on acquire. */
  async recover(owner: string) {
    for await (const c of listAll(this.store, owner)) this.schedule(owner, c.id);
  }
  /** Pick up conversations with pending work whose owner's lease expired (crashed worker). */
  async sweep(owner: string) {
    for await (const c of listAll(this.store, owner))
      if (
        c.jobs.some((j) => j.status === "queued" || j.status === "running") &&
        (!c.lease || c.lease.until <= dbNow(c)) &&
        !unresolved(c).length
      )
        this.schedule(owner, c.id);
  }
  /** Operator resolution of an unknown tool outcome; blocked work then resumes. */
  async resolveToolOutcome(
    owner: string,
    id: string,
    execId: string,
    outcome: "applied" | "not-applied",
    note?: string,
  ) {
    await this.store.mutate(owner, id, (c) => resolveUnknown(c, execId, outcome, note));
    this.notify(owner, id);
    this.schedule(owner, id);
  }
  /** The conversation was deleted: abort its run here and drop local ownership state. */
  async forget(owner: string, id: string) {
    const key = this.key(owner, id);
    const active = this.active.get(key);
    if (active) this.abortActive(active);
    this.leases.delete(key);
    await this.workers.get(key)?.catch(() => undefined);
    this.active.delete(key);
    this.leases.delete(key);
  }
  async idle(owner: string, id: string) {
    await this.workers.get(this.key(owner, id))?.catch(() => undefined);
  }
  async stop() {
    this.stopped = true;
    this.store.changes?.off("commit", this.onCommit);
    for (const a of this.active.values()) this.abortActive(a);
    await Promise.allSettled(this.workers.values());
  }
}
