/**
 * Conversation deletion: everything a conversation owns outside its rows goes with it.
 *
 * 1. Tombstone (one transaction): `deletedAt` set, queued/running work cancelled, epoch bumped so
 *    a worker still holding the old lease cannot write. From here the conversation is a 404 for
 *    every API, the idle reaper and the engine (none of them can snapshot or restart it).
 * 2. Local state: abort the run on this worker, close terminals, drop preview keep-alive.
 * 3. Compute, no snapshot save: purge every Nomad job of the conversation (all generations).
 * 4. Sandbox network (bridge + egress source mapping) via sandbox-netctl release.
 * 5. Egress policy file.
 * 6. S3: every object under sandboxes/<workspaceId>/ (snapshot and side-by-side
 *    after-failed-restore copies).
 * 7. Rows: journal + conversation row in one transaction (Store.purge, the only path the
 *    append-only trigger admits); preview-port and visual-reply (html render) rows cascade.
 *
 * Every step is idempotent. A failure leaves the tombstone in place and the sweeper (startup and
 * periodic) finishes the job; it also removes orphans: jobs, policy files, networks and
 * snapshots whose conversation key matches no conversation row at all.
 */
import { handsJobId, handsKey } from "./hands.ts";
import { append, type ConversationRef, type Store } from "./store.ts";

export interface DeletionTargets {
  nomad?: { purge(jobId: string): Promise<void>; jobIds?(prefix: string): Promise<string[]> };
  network?: { release?(conversationKey: string): Promise<void> };
  policies?: {
    remove(conversationKey: string): Promise<void>;
    keys?(): Promise<Array<{ key: string; mtimeMs: number }>>;
  };
  snapshots?: {
    list(prefix: string): Promise<Array<{ key: string; lastModified: string }>>;
    delete(key: string): Promise<void>;
  };
  /** In-process state of this worker (run, terminals, preview keep-alive). */
  local?(owner: string, id: string): Promise<void> | void;
}
export interface DeletionReport {
  owner: string;
  id: string;
  jobs: string[];
  network: boolean;
  policy: boolean;
  objects: string[];
  rows: boolean;
}
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
const JOB = /^hands-([a-z0-9]{12,40})-g\d+$/;
const OBJ = /^sandboxes\/ws-([a-z0-9]{12,40})\//;

export class ConversationDeleter {
  private timer?: NodeJS.Timeout;
  private sweeping = false;
  private readonly inFlight = new Map<string, Promise<DeletionReport>>();
  constructor(
    private readonly store: Store,
    private readonly targets: DeletionTargets,
    private readonly options: {
      log?: (m: string) => void;
      /** Orphans younger than this are left alone (a conversation being created). Default 10 min. */
      orphanGraceMs?: number;
      now?: () => number;
      networkRetries?: number;
      /** Orphans are only reported (logged), never removed. */
      orphanDryRun?: boolean;
      networkRetryMs?: number;
    } = {},
  ) {}
  private log(m: string) {
    this.options.log?.(m);
  }
  /** API entry: tombstone (404 if absent), then remove everything. Throws if cleanup failed. */
  async delete(owner: string, id: string): Promise<DeletionReport> {
    await this.tombstone(owner, id);
    return this.finish(owner, id);
  }
  async tombstone(owner: string, id: string) {
    await this.store.mutate(
      owner,
      id,
      (c) => {
        if (c.deletedAt) return;
        const now = new Date().toISOString();
        c.deletedAt = now;
        for (const j of c.jobs)
          if (j.status === "queued" || j.status === "running") j.status = "cancelled";
        c.epoch = (c.epoch ?? 0) + 1;
        c.lease = null;
        append(c, "conversation.deleted", {});
      },
      { includeDeleted: true },
    );
  }
  /** Remove a tombstoned conversation's data. Concurrent calls for one conversation share a run. */
  finish(owner: string, id: string): Promise<DeletionReport> {
    const k = `${owner}\0${id}`;
    let p = this.inFlight.get(k);
    if (!p) {
      p = this.run(owner, id).finally(() => this.inFlight.delete(k));
      this.inFlight.set(k, p);
    }
    return p;
  }
  private async run(owner: string, id: string): Promise<DeletionReport> {
    const key = handsKey(owner, id);
    const report: DeletionReport = {
      owner,
      id,
      jobs: [],
      network: false,
      policy: false,
      objects: [],
      rows: false,
    };
    // Read through the deletion path (normal reads 404 on a tombstone).
    const hands = await this.store
      .mutate(owner, id, (c) => c.hands ?? null, {
        includeDeleted: true,
      })
      .catch((e) => {
        if ((e as { status?: number }).status === 404) return undefined; // already purged
        throw e;
      });
    if (hands === undefined) return report;
    await this.targets.local?.(owner, id);
    const t = this.targets;
    if (t.nomad) {
      const ids = new Set<string>(t.nomad.jobIds ? await t.nomad.jobIds(`hands-${key}-`) : []);
      if (hands) for (let g = 1; g <= hands.generation; g++) ids.add(handsJobId(key, g));
      for (const job of ids) await t.nomad.purge(job);
      report.jobs = [...ids];
    }
    if (t.network?.release) {
      // Docker refuses to remove the bridge while the purged container is still stopping.
      for (let i = 0; ; i++) {
        try {
          await t.network.release(key);
          break;
        } catch (e) {
          if (i >= (this.options.networkRetries ?? 10)) throw e;
          await new Promise((r) => setTimeout(r, this.options.networkRetryMs ?? 3000));
        }
      }
      report.network = true;
    }
    if (t.policies) {
      await t.policies.remove(key);
      report.policy = true;
    }
    if (t.snapshots) {
      const ws = hands?.workspaceId ?? `ws-${key}`;
      for (const o of await t.snapshots.list(`sandboxes/${ws}/`)) {
        await t.snapshots.delete(o.key);
        report.objects.push(o.key);
      }
    }
    report.rows = await this.store.purge(owner, id);
    this.log(
      `conversation deleted (${id}): jobs=${report.jobs.length} objects=${report.objects.length} rows=${report.rows}`,
    );
    return report;
  }
  /** Finish pending deletions, then remove orphans. Never throws. */
  async sweep(): Promise<{ finished: number; orphans: string[] }> {
    if (this.sweeping) return { finished: 0, orphans: [] };
    this.sweeping = true;
    let finished = 0;
    const orphans: string[] = [];
    try {
      const refs = await this.store.refs();
      for (const r of refs.filter((x) => x.deletedAt))
        await this.finish(r.owner, r.id).then(
          () => void finished++,
          (e) => this.log(`deletion retry failed (${r.id}): ${why(e)}`),
        );
      orphans.push(...(await this.orphans(refs)));
    } catch (e) {
      this.log(`deletion sweep failed: ${why(e)}`);
    } finally {
      this.sweeping = false;
    }
    return { finished, orphans };
  }
  private async orphans(refs: ConversationRef[]) {
    const known = new Set<string>();
    for (const r of refs) {
      known.add(handsKey(r.owner, r.id));
      if (r.workspaceId) known.add(r.workspaceId.replace(/^ws-/, ""));
    }
    const now = this.options.now?.() ?? Date.now();
    const old = (ms: number) => now - ms > (this.options.orphanGraceMs ?? 10 * 60_000);
    const removed: string[] = [];
    const keys = new Set<string>();
    const t = this.targets;
    const step = async (what: string, f: () => Promise<void>) => {
      if (this.options.orphanDryRun) return void removed.push(what);
      try {
        await f();
        removed.push(what);
      } catch (e) {
        this.log(`orphan cleanup failed (${what}): ${why(e)}`);
      }
    };
    if (t.nomad?.jobIds)
      for (const job of await t.nomad.jobIds("hands-").catch(() => [] as string[])) {
        const k = JOB.exec(job)?.[1];
        if (k && !known.has(k)) {
          keys.add(k);
          await step(`job ${job}`, () => t.nomad!.purge(job));
        }
      }
    if (t.policies?.keys)
      for (const p of await t.policies.keys().catch(() => [])) {
        if (known.has(p.key) || !old(p.mtimeMs)) continue;
        keys.add(p.key);
        await step(`policy ${p.key}`, () => t.policies!.remove(p.key));
      }
    if (t.snapshots)
      for (const o of await t.snapshots.list("sandboxes/").catch(() => [])) {
        const k = OBJ.exec(o.key)?.[1];
        if (!k || known.has(k) || !old(Date.parse(o.lastModified) || now)) continue;
        await step(`object ${o.key}`, () => t.snapshots!.delete(o.key));
      }
    // Networks have no listing here; release the ones of orphaned jobs/policies.
    if (t.network?.release)
      for (const k of keys) await step(`network ${k}`, () => t.network!.release!(k));
    if (removed.length)
      this.log(
        `orphans ${this.options.orphanDryRun ? "found (dry run, kept)" : "removed"}: ${removed.join(", ")}`,
      );
    return removed;
  }
  start(intervalMs = 10 * 60_000) {
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref();
    return this;
  }
  stop() {
    clearInterval(this.timer);
  }
}
