// Pi Durable storage as an append-only Postgres commit log replayed into pi-durable's
// MemoryStorage (design proven on spike/durable-pg-log). Same shape as pi-durable's own
// JsonlStorage: memory validates and applies each batch (prepareCommit), the batches are
// appended in ONE Postgres transaction, and reads wait while an append is in flight. Any failure
// after a batch applied in memory poisons the instance: the caller reopens, and open() replays
// what Postgres actually holds (the truth), which covers the unknown-outcome case (COMMIT sent,
// reply lost).
//
// Log rows are JSON text, not jsonb: jsonb refuses \u0000 and would re-order keys; JSON.stringify
// escapes NUL and lone surrogates, so text keeps Durable's strings lossless.
import type { Context } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import type { Storage } from "@earendil-works/pi-durable";
import type pg from "pg";

type Writes = Parameters<Storage["commit"]>[0][number];
type Receive = Parameters<Storage["commit"]>[1];

export const DURABLE_LOG_SCHEMA = `CREATE TABLE IF NOT EXISTS prototype_durable_log (
  log_key text NOT NULL,
  seq bigint NOT NULL,
  writes text NOT NULL,
  PRIMARY KEY (log_key, seq)
)`;

export class PostgresLogPoisonedError extends Error {
  constructor(cause: unknown) {
    super("Postgres durable log is poisoned and must be reopened", { cause });
    this.name = "PostgresLogPoisonedError";
  }
}

export interface PostgresLogOptions {
  /**
   * Runs inside the append transaction before the INSERT. Throw to refuse the append (e.g. the
   * conversation lease epoch moved: another worker owns it). Nothing is stored then.
   */
  fence?: (client: pg.PoolClient) => Promise<void>;
  /** Test hook: runs after the INSERT, before COMMIT. */
  beforeCommit?: (client: pg.PoolClient) => Promise<void>;
}

export class PostgresLogStorage implements Storage {
  private readonly pool: pg.Pool;
  private readonly key: string;
  private readonly memory: MemoryStorage;
  private readonly opts: PostgresLogOptions;
  private writing: Promise<void> | undefined;
  private poisoned: Error | undefined;
  private closed = false;

  private constructor(pool: pg.Pool, key: string, memory: MemoryStorage, opts: PostgresLogOptions) {
    this.pool = pool;
    this.key = key;
    this.memory = memory;
    this.opts = opts;
  }

  static async ensureSchema(pool: pg.Pool) {
    await pool.query(DURABLE_LOG_SCHEMA);
  }

  /** Replay the log for `key` into a fresh MemoryStorage. */
  static async open(pool: pg.Pool, key: string, opts: PostgresLogOptions = {}) {
    const memory = new MemoryStorage();
    const { rows } = await pool.query<{ seq: string; writes: string }>(
      "SELECT seq, writes FROM prototype_durable_log WHERE log_key = $1 ORDER BY seq",
      [key],
    );
    for (const r of rows) {
      const seq = Number(r.seq) as Parameters<MemoryStorage["prepareCommit"]>[1];
      memory.prepareCommit(JSON.parse(r.writes) as Writes, seq).apply();
    }
    return new PostgresLogStorage(pool, key, memory, opts);
  }

  /** Delete a conversation's log (conversation deletion). */
  static async remove(pool: pg.Pool, key: string) {
    await pool.query("DELETE FROM prototype_durable_log WHERE log_key = $1", [key]);
  }

  private assertUsable() {
    if (this.poisoned) throw this.poisoned;
    if (this.closed) throw new Error("Storage is closed");
  }
  private async readable() {
    while (this.writing) await this.writing;
    this.assertUsable();
    return this.memory;
  }

  async commit(batches: readonly Writes[], receive: Receive, context: Context) {
    while (this.writing) await this.writing;
    this.assertUsable();
    let release!: () => void;
    this.writing = new Promise<void>((r) => (release = r));
    const seqs: number[] = [];
    const rows: { seq: number; writes: string }[] = [];
    let refused: { error: unknown } | undefined;
    try {
      for (const writes of batches) {
        let prepared;
        try {
          prepared = this.memory.prepareCommit(writes);
        } catch (error) {
          refused = { error };
          break;
        }
        rows.push({ seq: prepared.seq, writes: JSON.stringify(prepared.writes) });
        seqs.push(prepared.apply());
      }
      if (rows.length) await this.append(rows);
    } catch (error) {
      // Memory ran ahead of Postgres: poison so no read returns what may not be stored.
      if (seqs.length === 0) throw error;
      this.poisoned = new PostgresLogPoisonedError(error);
      throw this.poisoned;
    } finally {
      this.writing = undefined;
      release();
    }
    for (const [i, seq] of seqs.entries()) receive(i, seq as never);
    void context;
    return refused === undefined
      ? { stored: seqs.length }
      : { stored: seqs.length, refused: refused.error };
  }

  private async append(rows: { seq: number; writes: string }[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.opts.fence?.(client);
      const values = rows.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(", ");
      await client.query(
        `INSERT INTO prototype_durable_log (log_key, seq, writes) VALUES ${values}`,
        [this.key, ...rows.flatMap((r) => [r.seq, r.writes])],
      );
      await this.opts.beforeCommit?.(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  mintId: Storage["mintId"] = async () => {
    this.assertUsable();
    return this.memory.mintId();
  };
  conversation: Storage["conversation"] = async (...a) =>
    (await this.readable()).conversation(...a);
  scanConversations: Storage["scanConversations"] = async (...a) =>
    (await this.readable()).scanConversations(...a);
  // Overloaded in the interface: (id, ctx) or (conversationId, id, ctx).
  entry: Storage["entry"] = (async (...a: unknown[]) =>
    ((await this.readable()).entry as (...x: unknown[]) => unknown)(...a)) as Storage["entry"];
  findLatestHeadMarker: Storage["findLatestHeadMarker"] = async (...a) =>
    (await this.readable()).findLatestHeadMarker(...a);
  scanEntries: Storage["scanEntries"] = async (...a) => (await this.readable()).scanEntries(...a);
  task: Storage["task"] = async (...a) => (await this.readable()).task(...a);
  scanTasks: Storage["scanTasks"] = async (...a) => (await this.readable()).scanTasks(...a);
  submission: Storage["submission"] = async (...a) => (await this.readable()).submission(...a);
  scanSubmissions: Storage["scanSubmissions"] = async (...a) =>
    (await this.readable()).scanSubmissions(...a);
  submissionByRequest: Storage["submissionByRequest"] = async (...a) =>
    (await this.readable()).submissionByRequest(...a);
  findDocument: Storage["findDocument"] = async (...a) =>
    (await this.readable()).findDocument(...a);
  document: Storage["document"] = async (...a) => (await this.readable()).document(...a);
  scanDocuments: Storage["scanDocuments"] = async (...a) =>
    (await this.readable()).scanDocuments(...a);

  async close(context: Context) {
    while (this.writing) await this.writing;
    if (this.closed) return;
    this.closed = true;
    await this.memory.close(context);
  }
}

// Compile-time check that the class satisfies Durable's contract.
export const _check = (s: PostgresLogStorage): Storage => s;
