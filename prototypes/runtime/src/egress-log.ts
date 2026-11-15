/**
 * Per-conversation egress log: the egress proxy's audit log (infra/sandbox-kit/egress, one JSON
 * object per line, `sandbox` = the conversation's policy key, hands.ts handsKey) filtered to one
 * conversation. Only the tail of the file is read, so a busy node costs a bounded read. The proxy
 * never writes secret values; this view also drops anything but the listed fields.
 */
import { open } from "node:fs/promises";
import { handsKey } from "./hands.ts";

export interface EgressLogEntry {
  ts: string;
  event: string;
  host?: string;
  port?: number;
  method?: string;
  path?: string;
  decision?: string;
  reason?: string;
  status?: number;
  openWeb?: true;
  secretRule?: string;
}

const EVENTS = new Set(["request", "connect", "dns", "websocket", "tcp"]);
export const EGRESS_LOG_TAIL_BYTES = 4 * 1024 * 1024;
export const EGRESS_LOG_MAX_LIMIT = 500;

async function tail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // A partial first line (cut by the tail window) is dropped.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

function entry(raw: Record<string, unknown>): EgressLogEntry {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const out: EgressLogEntry = {
    ts: str(raw.ts) ?? "",
    event: str(raw.event) ?? "",
    host: str(raw.host),
    port: num(raw.port),
    method: str(raw.method),
    path: str(raw.path),
    decision: str(raw.decision),
    reason: str(raw.reason),
    status: num(raw.status),
    openWeb: raw.open_web === true ? true : undefined,
    secretRule: str(raw.secret_rule),
  };
  for (const k of Object.keys(out) as (keyof EgressLogEntry)[])
    if (out[k] === undefined) delete out[k];
  return out;
}

export class EgressLog {
  constructor(
    private readonly file: string,
    private readonly tailBytes = EGRESS_LOG_TAIL_BYTES,
  ) {}

  /** The newest `limit` entries for one conversation, newest last. A missing log is empty. */
  async recent(owner: string, conversationId: string, limit = 100): Promise<EgressLogEntry[]> {
    const key = handsKey(owner, conversationId);
    const n = Math.max(1, Math.min(EGRESS_LOG_MAX_LIMIT, Math.floor(limit) || 100));
    let text: string;
    try {
      text = await tail(this.file, this.tailBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const out: EgressLogEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.includes(key)) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (raw.sandbox !== key || !EVENTS.has(String(raw.event))) continue;
      out.push(entry(raw));
    }
    return out.slice(-n);
  }
}
