/**
 * Host-side `trino_query` (V1.2a, spec D13). Placeholder only: the in-memory `FakeTrino` is the
 * only client wired (TRINO_MODE=fake) until a real endpoint and service user exist. The HTTP client
 * below is written and tested against a fake server, but not wired.
 *
 * Rules:
 * - The query runs as the signed-in user's principal: the local part of their email
 *   (`trinoPrincipal`). No email, no query: it fails closed, never as the service user.
 * - The HTTP client authenticates as the service user and always sends `X-Trino-User`. A refused
 *   impersonation is a typed error and is never retried as the service user.
 * - The tool's policy is `destination: "production"` (recorded in the ledger; no taint). It needs
 *   the user's `trino` entitlement (entitlements.ts). The service credential never reaches the
 *   sandbox, the journal or logs.
 * - Sandboxes can never reach Trino: its hosts are refused in every egress rule file at startup
 *   and denied by the proxy (`deny_hosts`), even for the open-web tier (A1.4).
 */
import type { HostTool } from "./host-tools.ts";
import { ApiError } from "./store.ts";

export class TrinoError extends Error {
  constructor(
    message: string,
    readonly code: "no_principal" | "impersonation_denied" | "query_failed" | "timeout",
  ) {
    super(message);
  }
}

/** The Trino principal for a user: the local part of their email. Fails closed. */
export function trinoPrincipal(email: string | undefined | null): string {
  if (typeof email !== "string") throw new TrinoError("No email for this user", "no_principal");
  const at = email.lastIndexOf("@");
  if (at < 0) throw new TrinoError("Email has no @", "no_principal");
  const local = email.slice(0, at).trim().toLowerCase();
  if (!local || !/^[a-z0-9._+-]+$/.test(local))
    throw new TrinoError("Email local part is not a usable Trino principal", "no_principal");
  return local;
}

export interface TrinoResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}
export interface TrinoQueryOptions {
  maxRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface TrinoClient {
  query(principal: string, sql: string, options: TrinoQueryOptions): Promise<TrinoResult>;
}

/** In-memory placeholder: a fixed catalog, a tiny SQL subset, and typed impersonation errors. */
export class FakeTrino implements TrinoClient {
  readonly queries: Array<{ principal: string; sql: string }> = [];
  static readonly TABLES: Record<string, TrinoResult> = {
    "demo.orders": {
      columns: ["order_id", "customer", "total_usd"],
      rows: [
        [1, "acme", 120.5],
        [2, "globex", 75],
        [3, "initech", 310.25],
      ],
      truncated: false,
    },
    "demo.customers": {
      columns: ["customer", "region"],
      rows: [
        ["acme", "us-east"],
        ["globex", "eu-west"],
        ["initech", "us-west"],
      ],
      truncated: false,
    },
  };
  /** `principals`: who may be impersonated (undefined: anyone with a valid principal). */
  constructor(private readonly principals?: ReadonlySet<string>) {}
  async query(principal: string, sql: string, o: TrinoQueryOptions): Promise<TrinoResult> {
    o.signal?.throwIfAborted();
    if (this.principals && !this.principals.has(principal))
      throw new TrinoError(
        `Access Denied: User service cannot impersonate user ${principal}`,
        "impersonation_denied",
      );
    this.queries.push({ principal, sql });
    const q = sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
    if (/^show tables$/i.test(q))
      return {
        columns: ["table"],
        rows: Object.keys(FakeTrino.TABLES).map((t) => [t]),
        truncated: false,
      };
    const m = /^select \* from ([a-z_.]+)(?: limit (\d+))?$/i.exec(q);
    const table = m && FakeTrino.TABLES[m[1]!.toLowerCase()];
    if (!m || !table)
      throw new TrinoError(
        "FakeTrino supports only: SHOW TABLES; SELECT * FROM <table> [LIMIT n]",
        "query_failed",
      );
    const limit = Math.min(m[2] ? Number(m[2]) : Infinity, o.maxRows);
    return {
      columns: table.columns,
      rows: table.rows.slice(0, limit),
      truncated: table.rows.length > limit,
    };
  }
}

/**
 * Trino's HTTP protocol client (POST /v1/statement, then follow nextUri). Not wired in v1.
 * `credential` is read from a file by the caller; it is only ever put in the Authorization header.
 */
export class HttpTrinoClient implements TrinoClient {
  constructor(
    private readonly o: {
      url: string;
      serviceUser: string;
      credential: () => Promise<string>;
      fetch?: typeof fetch;
    },
  ) {}
  async query(principal: string, sql: string, q: TrinoQueryOptions): Promise<TrinoResult> {
    const f = this.o.fetch ?? fetch;
    const auth = `Basic ${Buffer.from(`${this.o.serviceUser}:${await this.o.credential()}`).toString("base64")}`;
    const headers = {
      authorization: auth,
      "x-trino-user": principal,
      "x-trino-source": "linguini",
    };
    const timeout = AbortSignal.timeout(q.timeoutMs);
    const signal = q.signal ? AbortSignal.any([q.signal, timeout]) : timeout;
    const columns: string[] = [];
    const rows: unknown[][] = [];
    let truncated = false;
    const fail = (status: number, body: { error?: { message?: string } } | undefined) => {
      const message = body?.error?.message ?? `Trino answered ${status}`;
      if (status === 403 || /cannot impersonate/i.test(message))
        // Never retried as the service user.
        throw new TrinoError(message.slice(0, 500), "impersonation_denied");
      throw new TrinoError(message.slice(0, 500), "query_failed");
    };
    let response: Response;
    try {
      response = await f(new URL("/v1/statement", this.o.url), {
        method: "POST",
        headers,
        body: sql,
        signal,
      });
      for (;;) {
        const body = (await response.json().catch(() => undefined)) as
          | {
              columns?: Array<{ name: string }>;
              data?: unknown[][];
              nextUri?: string;
              error?: { message?: string };
            }
          | undefined;
        if (!response.ok || body?.error) fail(response.status, body);
        if (body?.columns && !columns.length) columns.push(...body.columns.map((c) => c.name));
        for (const row of body?.data ?? []) {
          if (rows.length >= q.maxRows) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        if (!body?.nextUri || truncated) {
          if (truncated && body?.nextUri)
            await f(body.nextUri, { method: "DELETE", headers, signal }).catch(() => undefined);
          break;
        }
        response = await f(body.nextUri, { headers, signal });
      }
    } catch (error) {
      if (error instanceof TrinoError) throw error;
      if (timeout.aborted) throw new TrinoError("Trino query timed out", "timeout");
      throw new TrinoError("Trino request failed", "query_failed");
    }
    return { columns, rows, truncated };
  }
}

/** Hosts sandboxes may never reach: TRINO_URL's host (other hosts: EGRESS_DENY_HOSTS). */
export function trinoHostsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const hosts = new Set<string>();
  if (env.TRINO_URL) hosts.add(new URL(env.TRINO_URL).hostname.toLowerCase());
  return [...hosts];
}

const LIMITS = { maxRows: 200, maxBytes: 64 * 1024, timeoutMs: 30_000 };

function render(r: TrinoResult, maxBytes: number) {
  const cell = (v: unknown) =>
    (v === null || v === undefined ? "NULL" : String(v)).replace(/[\t\n\r]/g, " ");
  const lines = [r.columns.join("\t"), ...r.rows.map((row) => row.map(cell).join("\t"))];
  let out = "";
  let cut = r.truncated;
  for (const line of lines) {
    if (Buffer.byteLength(out) + Buffer.byteLength(line) + 1 > maxBytes) {
      cut = true;
      break;
    }
    out += `${line}\n`;
  }
  return `${out}(${r.rows.length} row${r.rows.length === 1 ? "" : "s"}${cut ? ", truncated" : ""})`;
}

/** `trino_query` as a host tool: read-only, production source, no write destination. */
export function trinoHostTool(o: {
  client: TrinoClient;
  /** The owner's email, from the auth store. */
  emailOf: (owner: string) => Promise<string | undefined>;
  limits?: Partial<typeof LIMITS>;
}): HostTool {
  const limits = { ...LIMITS, ...o.limits };
  return {
    // Reading production data (a label in the ledger; nothing else changes for the thread).
    policy: { replay: "safe-read", destination: "production", egress: false },
    writes: [],
    destinations: () => [],
    description:
      "Run a read-only SQL query on the data warehouse (Trino) as you. Results come back as tab-separated rows.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "One read-only SQL statement." },
        max_rows: { type: "number", description: `At most ${LIMITS.maxRows}.` },
      },
      required: ["sql"],
    },
    async handler(call, run) {
      const sql = call.args.sql;
      if (typeof sql !== "string" || !sql.trim() || sql.length > 20_000)
        throw new ApiError(400, "trino_query needs one SQL statement");
      const maxRows = Math.max(
        1,
        Math.min(Number(call.args.max_rows) || limits.maxRows, limits.maxRows),
      );
      try {
        const principal = trinoPrincipal(await o.emailOf(run.owner));
        const result = await o.client.query(principal, sql, {
          maxRows,
          timeoutMs: limits.timeoutMs,
          signal: run.signal,
        });
        return { text: render(result, limits.maxBytes) };
      } catch (error) {
        if (error instanceof TrinoError)
          throw new ApiError(
            error.code === "query_failed" ? 400 : 403,
            `trino_query: ${error.message}`,
            `trino_${error.code}`,
          );
        throw error;
      }
    },
  };
}
