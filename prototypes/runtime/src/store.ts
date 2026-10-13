import type { LedgerEntry } from "./ledger.ts";
import type { HandsBinding } from "./hands.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { Client, Pool, type PoolClient } from "pg";

export interface JournalEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  timestamp?: string;
}
/** A per-conversation execution lease. `epoch` is monotonic and never reused. */
export interface Lease {
  worker: string;
  epoch: number;
  until: number;
}
export interface Conversation {
  id: string;
  owner: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  /** Tombstone: the user deleted this conversation. Hidden everywhere; its sandbox data is being
   * removed (deletion.ts) and the rows are purged once that finishes. */
  deletedAt?: string;
  tainted: boolean;
  /** Files the user saved in the Files panel since Pi's last turn (files.ts); consumed by the
   * engine, which tells Pi about them at the start of its next turn. */
  userEdits?: string[];
  piEntries?: FileEntry[];
  metadata?: {
    archivedAt?: string | null;
    pinnedAt?: string | null;
    lastVisitedAt?: string | null;
    orderKey?: string | null;
    pinOrderKey?: string | null;
    activeOrderKey?: string | null;
    settledOverride?: "settled" | "active" | null;
    settledAt?: string | null;
    unsettledAt?: string | null;
  };
  sandbox: string | null;
  files: Record<string, string>;
  receipts: Record<string, { fingerprint: string; result: unknown }>;
  /** Durable tool-call ledger keyed by execution ID (see ledger.ts). Absent on older rows. */
  ledger?: Record<string, LedgerEntry>;
  /** Compute binding for real hands (hands.ts); absent with the fixture or remote providers. */
  hands?: HandsBinding;
  /**
   * Append-only journal. Stored in its own table, never in the conversation row.
   * Inside `Store.mutate` without `{ events: true }` this is append-only (push).
   */
  events: JournalEvent[];
  /** Highest journal sequence number committed for this conversation. */
  lastSeq?: number;
  /** Highest lease epoch ever issued for this conversation (monotonic). */
  epoch?: number;
  lease?: Lease | null;
  jobs: Array<{
    id: string;
    text: string;
    messageId?: string;
    kind?: "prompt" | "steer";
    target?: string;
    status: "queued" | "running" | "done" | "cancelled" | "interrupted" | "rejected";
    /** Execution IDs of unknown tool outcomes this queued job is waiting on. */
    blockedOn?: string[];
    /** Real turn timing (ISO), stamped by the store when the job appears / changes status.
     * Absent on jobs older than this field: readers fall back to journal timestamps. */
    requestedAt?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
}
export function initial(id: string, owner: string, title = "New conversation"): Conversation {
  return {
    id,
    owner,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tainted: false,
    sandbox: null,
    files: {},
    receipts: {},
    events: [],
    lastSeq: 0,
    epoch: 0,
    lease: null,
    jobs: [],
  };
}
export function append(c: Conversation, type: string, data: Record<string, unknown>): JournalEvent {
  c.updatedAt = new Date().toISOString();
  const seq = (c.lastSeq ?? c.events.at(-1)?.seq ?? 0) + 1;
  c.lastSeq = seq;
  const event = { timestamp: c.updatedAt, seq, type, data };
  c.events.push(event);
  return event;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
/** A worker's proof of ownership, checked inside the same transaction as each write. */
export interface Fence {
  worker: string;
  epoch: number;
}
const DB_NOW = Symbol("dbNow");
/** Attach the database clock reading to a conversation handed out by a store (never persisted). */
function stamp<C extends object>(c: C, now: number): C {
  Object.defineProperty(c, DB_NOW, { value: now, enumerable: false, configurable: true });
  return c;
}
/**
 * The database clock (ms since epoch) read in the same transaction or query that produced this
 * conversation. Every lease decision uses it, so worker clock skew cannot steal or prolong a lease.
 */
export function dbNow(c: Conversation): number {
  const now = (c as unknown as Record<symbol, unknown>)[DB_NOW];
  if (typeof now !== "number") throw new Error("Conversation carries no database clock reading");
  return now;
}
export class StaleOwnerError extends ApiError {
  constructor() {
    super(
      409,
      "Stale conversation owner: the execution lease was lost or taken over",
      "STALE_OWNER",
    );
  }
}
export function assertFence(c: Conversation, fence: Fence | undefined) {
  if (!fence) return;
  const lease = c.lease;
  if (
    !lease ||
    lease.worker !== fence.worker ||
    lease.epoch !== fence.epoch ||
    lease.until <= dbNow(c)
  )
    throw new StaleOwnerError();
}
export interface MutateOptions {
  /** Load the full journal into `c.events`. Without it, `c.events` only accepts `push`. */
  events?: boolean;
  /** Deletion path only: also open a tombstoned conversation (otherwise it is a 404). */
  includeDeleted?: boolean;
}
/** Every conversation row of every owner (deletion sweeper): ids and the hands workspace only. */
export interface ConversationRef {
  owner: string;
  id: string;
  deletedAt?: string;
  workspaceId?: string;
  /** The sandbox's state (hands binding), if it ever had one. */
  handsState?: string;
}
const gone = () => new ApiError(404, "Conversation not found");
export const LIST_PAGE_DEFAULT = 50;
export const LIST_PAGE_MAX = 200;
export const EVENT_PAGE_DEFAULT = 500;
export const EVENT_PAGE_MAX = 5_000;
export interface ListOptions {
  /** Exclusive id cursor: the `next` of the previous page. */
  after?: string;
  /** Page size, clamped to 1..LIST_PAGE_MAX. Default LIST_PAGE_DEFAULT. */
  limit?: number;
  /** Load each listed conversation's journal (up to its committed lastSeq). Default false. */
  events?: boolean;
}
export interface ConversationPage {
  items: Conversation[];
  /** Cursor for the following page, or null on the last page. */
  next: string | null;
}
function clampLimit(limit: number | undefined, fallback: number, max: number) {
  const n = limit !== undefined && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(max, Math.max(1, n));
}
/** Every conversation of an owner, one page at a time (no journals unless asked). */
export async function* listAll(
  store: Store,
  owner: string,
  options: Omit<ListOptions, "after"> = {},
) {
  let after: string | undefined;
  do {
    const page = await store.list(owner, { ...options, ...(after === undefined ? {} : { after }) });
    yield* page.items;
    after = page.next ?? undefined;
  } while (after !== undefined);
}
function groupEvents(rows: Array<JournalEvent & { conversation: string }>) {
  const byId = new Map<string, JournalEvent[]>();
  for (const { conversation, ...e } of rows) {
    let list = byId.get(conversation);
    if (!list) byId.set(conversation, (list = []));
    list.push(e);
  }
  return byId;
}
export interface Store {
  changes?: EventEmitter;
  /**
   * Test seam only: shifts this store's reading of the database clock, standing in for the
   * passage of time. Production code never sets it.
   */
  testClockOffsetMs: number;
  create(c: Conversation): Promise<void>;
  /**
   * One page of the owner's conversations, ordered by id, starting after `options.after`.
   * The journal is only loaded with `events: true`, for that page alone, in one query.
   */
  list(owner: string, options?: ListOptions): Promise<ConversationPage>;
  /** A consistent snapshot without taking the row lock; `events: false` skips the journal. */
  snapshot(owner: string, id: string, options?: { events?: boolean }): Promise<Conversation>;
  /** Up to `limit` (default EVENT_PAGE_DEFAULT) journal entries with seq > after, in order. */
  events(owner: string, id: string, after: number, limit?: number): Promise<JournalEvent[]>;
  mutate<T>(
    owner: string,
    id: string,
    f: (c: Conversation) => T,
    options?: MutateOptions,
  ): Promise<T>;
  /** All rows, tombstoned ones included (sweeper: what still counts as a live owner of data). */
  refs(): Promise<ConversationRef[]>;
  /**
   * The one sanctioned way to remove a conversation's rows: only a tombstoned conversation, its
   * whole journal and its row at once (preview port rows cascade). The append-only trigger
   * admits these deletes only inside this transaction. Idempotent (absent: no-op).
   */
  purge(owner: string, id: string): Promise<boolean>;
  close(): Promise<void>;
}
export async function read(store: Store, owner: string, id: string): Promise<Conversation> {
  return store.snapshot(owner, id);
}

const notLoaded = () => {
  throw new Error("Journal not loaded in this mutation; pass { events: true }");
};
/** An append-only view of the journal for mutations that do not need history. */
function appendOnly(pending: JournalEvent[]): JournalEvent[] {
  return new Proxy(pending, {
    get(target, key) {
      if (key === "push") return (...items: JournalEvent[]) => target.push(...items);
      return notLoaded();
    },
    set: notLoaded,
  }) as JournalEvent[];
}
type Row = Omit<Conversation, "events">;
/** Shared transaction body: returns the state to persist, new journal entries and the callback value. */
const TERMINAL_JOB = new Set(["done", "cancelled", "interrupted", "rejected"]);
/**
 * Turn timing: only jobs that appear or change status in this mutation are stamped, so an old
 * job (from before these fields) never gets a made-up time from an unrelated write.
 */
export function stampJobTimes(
  before: Array<{ id: string; status: string }>,
  after: Conversation["jobs"],
  now: string,
) {
  const prev = new Map(before.map((j) => [j.id, j.status]));
  for (const j of after) {
    const was = prev.get(j.id);
    if (was === j.status) continue;
    if (was === undefined) j.requestedAt ??= now;
    if (j.status === "running") j.startedAt ??= now;
    if (TERMINAL_JOB.has(j.status)) {
      // Never started (cancelled while queued): no start time, so no duration.
      j.completedAt ??= now;
    }
  }
}
function apply<T>(
  row: Row,
  history: JournalEvent[] | undefined,
  f: (c: Conversation) => T,
  now: number,
): { state: Row; added: JournalEvent[]; value: T; changed: boolean } {
  const before = JSON.stringify(row);
  const baseSeq = row.lastSeq ?? 0;
  const pending: JournalEvent[] = [];
  const view = history ? [...history] : appendOnly(pending);
  const c = stamp({ ...row, lastSeq: baseSeq, events: view } as Conversation, now);
  // Statuses before f (job objects are shared with `row` and mutated in place).
  const statusesBefore = (c.jobs ?? []).map((j) => ({ id: j.id, status: j.status }));
  const value = f(c);
  if (value instanceof Promise) throw new Error("Store mutations must be synchronous");
  stampJobTimes(statusesBefore, c.jobs ?? [], new Date().toISOString());
  const journal = c.events;
  const added = (journal === view && !history ? pending : journal.filter((e) => e.seq > baseSeq))
    .slice()
    .sort((a, b) => a.seq - b.seq);
  added.forEach((e, i) => {
    if (e.seq !== baseSeq + i + 1) throw new Error("Journal sequence must be contiguous");
  });
  const { events: _events, ...state } = c;
  state.lastSeq = baseSeq + added.length;
  // Lease renewals alone are not user-visible changes.
  const visible = (s: Row) =>
    JSON.stringify({ ...s, lease: s.lease ? { ...s.lease, until: 0 } : s.lease });
  const changed = added.length > 0 || visible(JSON.parse(before)) !== visible(state);
  return { state, added, value, changed };
}
function splitInitial(c: Conversation): { row: Row; events: JournalEvent[] } {
  const { events, ...row } = structuredClone(c);
  row.lastSeq = Math.max(row.lastSeq ?? 0, events.at(-1)?.seq ?? 0);
  row.epoch ??= 0;
  row.lease ??= null;
  return { row, events };
}

// Conversation state stays in one row (jobs, receipts, files); the journal is a
// separate append-only table keyed by (conversation, seq). Sequence numbers are
// allocated under the row lock, so they commit in order with no gaps.
export class SqliteStore implements Store {
  readonly changes = new EventEmitter();
  testClockOffsetMs = 0;
  /** SQLite's own clock (the database host's), never the JavaScript process clock. */
  private dbNow(): number {
    const row = this.db
      .prepare("SELECT CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER) AS now")
      .get() as { now: number };
    return Number(row.now) + this.testClockOffsetMs;
  }
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_events (conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, ts TEXT, PRIMARY KEY (conversation_id, seq));
      CREATE TRIGGER IF NOT EXISTS conversation_events_append_only_u BEFORE UPDATE ON conversation_events BEGIN SELECT RAISE(ABORT, 'conversation_events is append-only'); END;
      CREATE TABLE IF NOT EXISTS conversation_purges (id TEXT PRIMARY KEY);
      DROP TRIGGER IF EXISTS conversation_events_append_only_d;
      CREATE TRIGGER conversation_events_append_only_d BEFORE DELETE ON conversation_events
        WHEN OLD.conversation_id NOT IN (SELECT id FROM conversation_purges)
        BEGIN SELECT RAISE(ABORT, 'conversation_events is append-only'); END;`);
    this.migrate();
  }
  /** v1 kept the journal inside the state row; move it to the events table once. */
  private migrate() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT id, state FROM conversations").all() as Array<{
        id: string;
        state: string;
      }>;
      for (const r of rows) {
        const state = JSON.parse(r.state) as Conversation;
        if (!Array.isArray(state.events)) continue;
        const { row, events } = splitInitial(state);
        this.insertEvents(r.id, events);
        this.db
          .prepare("UPDATE conversations SET state=? WHERE id=?")
          .run(JSON.stringify(row), r.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private insertEvents(id: string, events: JournalEvent[]) {
    const insert = this.db.prepare("INSERT INTO conversation_events VALUES (?, ?, ?, ?, ?)");
    for (const e of events)
      insert.run(id, e.seq, e.type, JSON.stringify(e.data), e.timestamp ?? null);
  }
  private loadEvents(id: string, after = 0, limit = -1): JournalEvent[] {
    return (
      this.db
        .prepare(
          "SELECT seq, type, data, ts FROM conversation_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?",
        )
        .all(id, after, limit) as Array<{
        seq: number;
        type: string;
        data: string;
        ts: string | null;
      }>
    ).map((e) => ({
      seq: Number(e.seq),
      type: e.type,
      data: JSON.parse(e.data),
      ...(e.ts ? { timestamp: e.ts } : {}),
    }));
  }
  async create(c: Conversation) {
    const { row, events } = splitInitial(c);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare("INSERT OR IGNORE INTO conversations VALUES (?, ?, ?)")
        .run(c.id, c.owner, JSON.stringify(row));
      if (inserted.changes) this.insertEvents(c.id, events);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    await this.snapshot(c.owner, c.id);
  }
  async list(owner: string, options: ListOptions = {}): Promise<ConversationPage> {
    const limit = clampLimit(options.limit, LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
    // One read transaction, so rows and journals agree.
    this.db.exec("BEGIN");
    try {
      const rows = this.db
        .prepare("SELECT id, state FROM conversations WHERE owner=? AND id>? ORDER BY id LIMIT ?")
        .all(owner, options.after ?? "", limit + 1) as Array<{ id: string; state: string }>;
      const page = rows
        .slice(0, limit)
        .map((r) => ({ id: r.id, state: JSON.parse(r.state) as Row }));
      let journals = new Map<string, JournalEvent[]>();
      if (options.events && page.length) {
        const raw = this.db
          .prepare(
            `SELECT e.conversation_id AS conversation, e.seq, e.type, e.data, e.ts
             FROM conversation_events e JOIN json_each(?) p ON e.conversation_id = p.value->>'$[0]'
             WHERE e.seq <= p.value->>'$[1]' ORDER BY e.conversation_id, e.seq`,
          )
          .all(JSON.stringify(page.map((r) => [r.id, r.state.lastSeq ?? 0]))) as Array<{
          conversation: string;
          seq: number;
          type: string;
          data: string;
          ts: string | null;
        }>;
        journals = groupEvents(
          raw.map((e) => ({
            conversation: e.conversation,
            seq: Number(e.seq),
            type: e.type,
            data: JSON.parse(e.data),
            ...(e.ts ? { timestamp: e.ts } : {}),
          })),
        );
      }
      const now = this.dbNow();
      this.db.exec("COMMIT");
      return {
        items: page
          .filter((r) => !r.state.deletedAt)
          .map((r) => stamp({ ...r.state, events: journals.get(r.id) ?? [] }, now)),
        next: rows.length > limit ? page.at(-1)!.id : null,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async snapshot(owner: string, id: string, options: { events?: boolean } = {}) {
    const row = this.db.prepare("SELECT owner,state FROM conversations WHERE id=?").get(id) as
      | { owner: string; state: string }
      | undefined;
    if (!row || row.owner !== owner) throw new ApiError(404, "Conversation not found");
    const state = JSON.parse(row.state) as Row,
      now = this.dbNow();
    if (state.deletedAt) throw gone();
    if (options.events === false) return stamp({ ...state, events: [] }, now);
    const events = this.loadEvents(id).filter((e) => e.seq <= (state.lastSeq ?? 0));
    return stamp({ ...state, events }, now);
  }
  async events(owner: string, id: string, after: number, limit?: number) {
    await this.snapshot(owner, id, { events: false });
    return this.loadEvents(id, after, clampLimit(limit, EVENT_PAGE_DEFAULT, EVENT_PAGE_MAX));
  }
  async mutate<T>(
    owner: string,
    id: string,
    f: (c: Conversation) => T,
    options: MutateOptions = {},
  ): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT owner,state FROM conversations WHERE id=?").get(id) as
        | { owner: string; state: string }
        | undefined;
      if (!row || row.owner !== owner) throw new ApiError(404, "Conversation not found");
      const parsed = JSON.parse(row.state) as Row;
      if (parsed.deletedAt && !options.includeDeleted) throw gone();
      const result = apply(
        parsed,
        options.events ? this.loadEvents(id) : undefined,
        f,
        this.dbNow(),
      );
      this.insertEvents(id, result.added);
      this.db
        .prepare("UPDATE conversations SET state=? WHERE id=?")
        .run(JSON.stringify(result.state), id);
      this.db.exec("COMMIT");
      if (result.changed) this.changes.emit("commit", owner, id);
      return result.value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async refs() {
    const rows = this.db.prepare("SELECT id, owner, state FROM conversations").all() as Array<{
      id: string;
      owner: string;
      state: string;
    }>;
    return rows.map((r) => {
      const s = JSON.parse(r.state) as Row;
      return {
        owner: r.owner,
        id: r.id,
        ...(s.deletedAt ? { deletedAt: s.deletedAt } : {}),
        ...(s.hands?.workspaceId ? { workspaceId: s.hands.workspaceId } : {}),
        ...(s.hands?.state ? { handsState: s.hands.state } : {}),
      };
    });
  }
  async purge(owner: string, id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT owner,state FROM conversations WHERE id=?").get(id) as
        | { owner: string; state: string }
        | undefined;
      if (!row || row.owner !== owner) {
        this.db.exec("COMMIT");
        return false;
      }
      if (!(JSON.parse(row.state) as Row).deletedAt)
        throw new ApiError(409, "Only a deleted conversation can be purged");
      this.db.prepare("INSERT OR IGNORE INTO conversation_purges VALUES (?)").run(id);
      this.db.prepare("DELETE FROM conversation_events WHERE conversation_id=?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id=?").run(id);
      this.db.prepare("DELETE FROM conversation_purges WHERE id=?").run(id);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async close() {
    this.db.close();
  }
}

const NOTIFY_CHANNEL = "prototype_conversation_changes";
/** Postgres server clock in ms. clock_timestamp() is the server's wall clock at evaluation. */
const PG_NOW = "(extract(epoch from clock_timestamp()) * 1000)::float8";
export class PostgresStore implements Store {
  readonly changes = new EventEmitter();
  testClockOffsetMs = 0;
  private readonly instance = randomUUID();
  private constructor(
    private pool: Pool,
    private listener: Client | null,
  ) {
    this.changes.setMaxListeners(0);
  }
  static async open(url: string, options: { listen?: boolean } = {}) {
    const pool = new Pool({ connectionString: url });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize schema setup and the one-time journal migration across workers.
      await client.query("SELECT pg_advisory_xact_lock(731942062)");
      await client.query(`
        CREATE TABLE IF NOT EXISTS prototype_conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS prototype_events (
          conversation_id TEXT NOT NULL REFERENCES prototype_conversations(id),
          seq BIGINT NOT NULL CHECK (seq > 0),
          type TEXT NOT NULL,
          data JSONB NOT NULL,
          ts TEXT,
          PRIMARY KEY (conversation_id, seq));
        -- Append-only, with one sanctioned exception: PostgresStore.purge deletes the journal of a
        -- tombstoned conversation, naming it in a transaction-local setting. Updates never pass.
        CREATE OR REPLACE FUNCTION prototype_events_append_only() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN
            IF TG_OP = 'DELETE'
               AND OLD.conversation_id = current_setting('linguini.purge_conversation', true)
               AND EXISTS (SELECT 1 FROM prototype_conversations c
                           WHERE c.id = OLD.conversation_id AND c.state ? 'deletedAt') THEN
              RETURN OLD;
            END IF;
            RAISE EXCEPTION 'prototype_events is append-only';
          END $$;
        DROP TRIGGER IF EXISTS prototype_events_append_only ON prototype_events;
        CREATE TRIGGER prototype_events_append_only BEFORE UPDATE OR DELETE ON prototype_events
          FOR EACH ROW EXECUTE FUNCTION prototype_events_append_only();
        -- Migration v3: optional project grouping (nullable, unused for now; the UI hides projects).
        -- Checked first: ALTER takes an exclusive table lock even when the column exists.
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'prototype_conversations'
                AND column_name = 'project_id') THEN
            ALTER TABLE prototype_conversations ADD COLUMN project_id TEXT;
          END IF;
        END $$;
        -- Migration v1 -> v2: move the journal out of the state row.
        INSERT INTO prototype_events (conversation_id, seq, type, data, ts)
          SELECT c.id, (e->>'seq')::bigint, e->>'type', COALESCE(e->'data', '{}'::jsonb), e->>'timestamp'
          FROM prototype_conversations c, jsonb_array_elements(c.state->'events') e
          WHERE jsonb_typeof(c.state->'events') = 'array'
          ON CONFLICT DO NOTHING;
        UPDATE prototype_conversations c SET state = (c.state - 'events') || jsonb_build_object(
            'lastSeq', GREATEST(COALESCE((c.state->>'lastSeq')::bigint, 0),
              COALESCE((SELECT max(seq) FROM prototype_events e WHERE e.conversation_id = c.id), 0)),
            'epoch', COALESCE(c.state->'epoch', '0'::jsonb),
            'lease', COALESCE(c.state->'lease', 'null'::jsonb))
          WHERE c.state ? 'events';`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    let listener: Client | null = null;
    if (options.listen !== false) {
      listener = new Client({ connectionString: url });
      await listener.connect();
      await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);
    }
    const store = new PostgresStore(pool, listener);
    // Other workers' commits reach this worker's live streams.
    listener?.on("notification", (message) => {
      try {
        const { instance, owner, id } = JSON.parse(message.payload ?? "{}");
        if (instance !== store.instance && typeof owner === "string" && typeof id === "string")
          store.changes.emit("commit", owner, id);
      } catch {}
    });
    listener?.on("error", () => undefined);
    return store;
  }
  private async loadEvents(
    client: Pool | PoolClient,
    id: string,
    after = 0,
    upTo?: number,
    limit?: number,
  ) {
    const rows = await client.query<{
      seq: string;
      type: string;
      data: Record<string, unknown>;
      ts: string | null;
    }>(
      "SELECT seq, type, data, ts FROM prototype_events WHERE conversation_id=$1 AND seq>$2 AND ($3::bigint IS NULL OR seq <= $3) ORDER BY seq LIMIT $4",
      [id, after, upTo ?? null, limit ?? null],
    );
    return rows.rows.map((e) => ({
      seq: Number(e.seq),
      type: e.type,
      data: e.data,
      ...(e.ts ? { timestamp: e.ts } : {}),
    }));
  }
  private async insertEvents(client: PoolClient, id: string, events: JournalEvent[]) {
    if (!events.length) return;
    await client.query(
      `INSERT INTO prototype_events (conversation_id, seq, type, data, ts)
       SELECT $1, (e->>'seq')::bigint, e->>'type', e->'data', e->>'timestamp' FROM jsonb_array_elements($2::jsonb) e`,
      [id, JSON.stringify(events)],
    );
  }
  async create(c: Conversation) {
    const { row, events } = splitInitial(c);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        "INSERT INTO prototype_conversations VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [c.id, c.owner, JSON.stringify(row)],
      );
      if (inserted.rowCount) await this.insertEvents(client, c.id, events);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await this.snapshot(c.owner, c.id);
  }
  async list(owner: string, options: ListOptions = {}): Promise<ConversationPage> {
    const limit = clampLimit(options.limit, LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
    const rows = await this.pool.query<{ id: string; state: Row; now: number }>(
      `SELECT id, state, ${PG_NOW} AS now FROM prototype_conversations
       WHERE owner=$1 AND id > $2 ORDER BY id LIMIT $3`,
      [owner, options.after ?? "", limit + 1],
    );
    const page = rows.rows.slice(0, limit);
    let journals = new Map<string, JournalEvent[]>();
    if (options.events && page.length) {
      // One query for the page; each journal is cut at the lastSeq its row was read with.
      const raw = await this.pool.query<{
        conversation: string;
        seq: string;
        type: string;
        data: Record<string, unknown>;
        ts: string | null;
      }>(
        `SELECT e.conversation_id AS conversation, e.seq, e.type, e.data, e.ts
         FROM prototype_events e
         JOIN unnest($1::text[], $2::bigint[]) AS p(id, last) ON e.conversation_id = p.id
         WHERE e.seq <= p.last ORDER BY e.conversation_id, e.seq`,
        [page.map((r) => r.id), page.map((r) => r.state.lastSeq ?? 0)],
      );
      journals = groupEvents(
        raw.rows.map((e) => ({
          conversation: e.conversation,
          seq: Number(e.seq),
          type: e.type,
          data: e.data,
          ...(e.ts ? { timestamp: e.ts } : {}),
        })),
      );
    }
    return {
      items: page
        .filter((r) => !r.state.deletedAt)
        .map((r) =>
          stamp(
            { ...r.state, events: journals.get(r.id) ?? [] },
            Number(r.now) + this.testClockOffsetMs,
          ),
        ),
      next: rows.rows.length > limit ? page.at(-1)!.id : null,
    };
  }
  async snapshot(owner: string, id: string, options: { events?: boolean } = {}) {
    const result = await this.pool.query<{ state: Row; now: number }>(
      `SELECT state, ${PG_NOW} AS now FROM prototype_conversations WHERE id=$1 AND owner=$2`,
      [id, owner],
    );
    const state = result.rows[0]?.state;
    if (!state || state.deletedAt) throw gone();
    const now = Number(result.rows[0]!.now) + this.testClockOffsetMs;
    if (options.events === false) return stamp({ ...state, events: [] }, now);
    // Events above the row's lastSeq belong to a later commit; exclude them for consistency.
    return stamp(
      { ...state, events: await this.loadEvents(this.pool, id, 0, state.lastSeq ?? 0) },
      now,
    );
  }
  async events(owner: string, id: string, after: number, limit?: number) {
    const result = await this.pool.query<{ last: string | null }>(
      "SELECT state->>'lastSeq' AS last FROM prototype_conversations WHERE id=$1 AND owner=$2 AND NOT state ? 'deletedAt'",
      [id, owner],
    );
    if (!result.rows[0]) throw new ApiError(404, "Conversation not found");
    return this.loadEvents(
      this.pool,
      id,
      after,
      Number(result.rows[0].last ?? 0),
      clampLimit(limit, EVENT_PAGE_DEFAULT, EVENT_PAGE_MAX),
    );
  }
  async mutate<T>(
    owner: string,
    id: string,
    f: (c: Conversation) => T,
    options: MutateOptions = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ state: Row }>(
        "SELECT state FROM prototype_conversations WHERE id=$1 AND owner=$2 FOR UPDATE",
        [id, owner],
      );
      const row = result.rows[0]?.state;
      if (!row || (row.deletedAt && !options.includeDeleted)) throw gone();
      // Read the clock only after the row lock is held: now() is the transaction start time and
      // would be stale by however long this transaction waited for the lock.
      const clock = await client.query<{ now: number }>(`SELECT ${PG_NOW} AS now`);
      const applied = apply(
        row,
        options.events ? await this.loadEvents(client, id) : undefined,
        f,
        Number(clock.rows[0]!.now) + this.testClockOffsetMs,
      );
      await this.insertEvents(client, id, applied.added);
      await client.query("UPDATE prototype_conversations SET state=$1 WHERE id=$2", [
        JSON.stringify(applied.state),
        id,
      ]);
      if (applied.changed)
        await client.query("SELECT pg_notify($1, $2)", [
          NOTIFY_CHANNEL,
          JSON.stringify({ instance: this.instance, owner, id }),
        ]);
      await client.query("COMMIT");
      if (applied.changed) this.changes.emit("commit", owner, id);
      return applied.value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async refs() {
    const r = await this.pool.query<{
      id: string;
      owner: string;
      d: string | null;
      w: string | null;
      h: string | null;
    }>(
      `SELECT id, owner, state->>'deletedAt' AS d, state->'hands'->>'workspaceId' AS w,
              state->'hands'->>'state' AS h
       FROM prototype_conversations`,
    );
    return r.rows.map((x) => ({
      owner: x.owner,
      id: x.id,
      ...(x.d ? { deletedAt: x.d } : {}),
      ...(x.w ? { workspaceId: x.w } : {}),
      ...(x.h ? { handsState: x.h } : {}),
    }));
  }
  async purge(owner: string, id: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = await client.query<{ deleted: boolean }>(
        "SELECT state ? 'deletedAt' AS deleted FROM prototype_conversations WHERE id=$1 AND owner=$2 FOR UPDATE",
        [id, owner],
      );
      if (!row.rows[0]) {
        await client.query("COMMIT");
        return false;
      }
      if (!row.rows[0].deleted)
        throw new ApiError(409, "Only a deleted conversation can be purged");
      await client.query("SELECT set_config('linguini.purge_conversation', $1, true)", [id]);
      await client.query("DELETE FROM prototype_events WHERE conversation_id=$1", [id]);
      // Preview port rows go with the row (ON DELETE CASCADE).
      await client.query("DELETE FROM prototype_conversations WHERE id=$1", [id]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.listener?.end().catch(() => undefined);
    await this.pool.end();
  }
}
