import {
  commandDisplayText,
  commandProgramName,
  withVisibleControlCharacters,
} from "@t3tools/client-runtime/work-log/command-label";

export interface Event {
  seq: number;
  timestamp?: string;
  type: string;
  data: Record<string, unknown>;
}
export interface PreviewPort {
  port: number;
  label: string;
  cspSandbox: boolean;
  createdAt: string;
  url: string | null;
}
export interface Job {
  id: string;
  text: string;
  status: string;
  kind?: string;
  messageId?: string;
  /** Real turn timing from the backend (absent on older turns). */
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string;
}
export interface Conversation {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  title: string;
  tainted: boolean;
  sandboxAllocated: boolean;
  jobs: Job[];
  events: Event[];
  /** Tool calls whose outcome is unknown; further work is blocked until each is resolved. */
  toolOutcomesUnknown?: UnknownOutcome[];
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
}
export interface UnknownOutcome {
  execId: string;
  callId: string;
  tool: string;
  destination: string;
  reason?: string;
  /** Evidence only: results a worker reported after it lost the call. */
  lateObservations?: Array<{ epoch: number; currentEpoch: number; text: string }>;
}
/** A backend refusal carrying the HTTP status and typed conflict code (e.g. STEER_TARGET_NOT_ACTIVE). */
export class OwnedApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}
export interface WireCommand {
  messageId?: string;
  commandId: string;
  kind: "prompt" | "queue" | "steer" | "cancel" | "queue_cancel" | "queue_edit" | "queue_reorder";
  jobId?: string;
  beforeJobId?: string | null;
  text?: string;
  targetJobId?: string;
}
export function mergeEvent(c: Conversation, event: Event): Conversation {
  if (event.seq <= (c.events.at(-1)?.seq ?? 0)) return c;
  const jobs = c.jobs.map((j) => ({ ...j }));
  let job = jobs.find((j) => j.id === event.data.jobId);
  if (event.type === "message.user" && !job) {
    job = {
      id: String(event.data.jobId),
      text: String(event.data.text),
      status: "queued",
      kind: String(event.data.kind),
    };
    jobs.push(job);
  }
  const status = (
    {
      "run.started": "running",
      "run.completed": "done",
      "run.cancelled": "cancelled",
      "run.interrupted": "interrupted",
      "steering.accepted": "done",
      "steering.interrupted": "interrupted",
      "steering.rejected": "rejected",
    } as Record<string, string>
  )[event.type];
  if (job && status) job.status = status;
  return {
    ...c,
    jobs,
    events: [...c.events, event],
    sandboxAllocated: c.sandboxAllocated || event.type === "sandbox.allocated",
    tainted:
      c.tainted ||
      event.data.productionData === true ||
      (event.type === "taint.changed" && event.data.tainted === true),
  };
}
export function toolLabel(event: Event): string {
  const args = event.data.args as Record<string, unknown> | undefined;
  return event.data.tool === "bash" && typeof args?.command === "string"
    ? `Ran ${commandProgramName(args.command) ?? "command"}: ${withVisibleControlCharacters(commandDisplayText(args.command))}`
    : `${String(event.data.tool)} ${typeof args?.path === "string" ? args.path : ""}`.trim();
}
export class OwnedAdapter {
  private token: string;
  private fetchFn: typeof fetch;
  private baseUrl: string;
  constructor(
    token: string,
    fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
    baseUrl = "",
  ) {
    this.token = token;
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl;
  }
  private async request(path: string, input?: unknown, signal?: AbortSignal) {
    const response = await this.fetchFn(this.baseUrl + path, {
      method: input === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const error = (await response.json()) as { error?: string; code?: string };
      throw new OwnedApiError(
        error.error ?? `Backend returned ${response.status}`,
        response.status,
        error.code,
      );
    }
    return response;
  }
  async session() {
    return (await (await this.request("/api/session")).json()) as {
      owner: string;
      /** AUTH_MODE=better-auth: the signed-in Better Auth user. */
      user?: { id: string; email: string; name: string | null; admin?: boolean } | null;
    };
  }
  /** AUTH_MODE=better-auth: this account's saved preferences (theme lives in prefs.theme). */
  async mySettings() {
    return (await (await this.request("/api/me/settings")).json()).settings as {
      prefs?: Record<string, unknown>;
    };
  }
  async saveMySettings(settings: { prefs?: Record<string, unknown> }) {
    const response = await this.fetchFn(this.baseUrl + "/api/me/settings", {
      method: "PUT",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (!response.ok) throw new OwnedApiError(`Settings not saved (${response.status})`, response.status);
    return response.json();
  }
  /** Every conversation, fetched one server page at a time (see X-Next-Cursor). */
  async list(pageSize = 50) {
    const all: Conversation[] = [];
    let cursor: string | null = null;
    do {
      const query: string =
        `?limit=${pageSize}` + (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`);
      const response = await this.request(`/api/conversations${query}`);
      all.push(...((await response.json()) as Conversation[]));
      const next = response.headers.get("x-next-cursor");
      if (next !== null && next === cursor) throw new Error("Conversation paging did not advance");
      cursor = next;
    } while (cursor !== null);
    return all;
  }
  async create(id: string, title: string) {
    return (await (await this.request("/api/conversations", { id, title })).json()) as Conversation;
  }
  /** Shared preview ports of a conversation (empty when previews are not configured). */
  async previews(id: string): Promise<PreviewPort[]> {
    try {
      const r = await this.request(`/api/conversations/${encodeURIComponent(id)}/previews`);
      return ((await r.json()) as { previews: PreviewPort[] }).previews;
    } catch (error) {
      if (error instanceof OwnedApiError && (error.status === 404 || error.status === 501))
        return [];
      throw error;
    }
  }
  async sharePort(id: string, port: number, label?: string) {
    await this.request(`/api/conversations/${encodeURIComponent(id)}/previews`, {
      port,
      ...(label ? { label } : {}),
    });
  }
  async unsharePort(id: string, port: number) {
    const response = await this.fetchFn(
      `${this.baseUrl}/api/conversations/${encodeURIComponent(id)}/previews/${port}`,
      { method: "DELETE", headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!response.ok)
      throw new OwnedApiError(`Backend returned ${response.status}`, response.status);
  }
  /** Delete the conversation and all its sandbox data (idempotent: already gone is success). */
  async deleteConversation(id: string) {
    const response = await this.fetchFn(
      `${this.baseUrl}/api/conversations/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${this.token}` } },
    );
    if (response.status === 404) return { deleted: true, pending: false };
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new OwnedApiError(
        error.error ?? `Backend returned ${response.status}`,
        response.status,
        error.code,
      );
    }
    return (await response.json()) as { deleted: boolean; pending: boolean };
  }
  async snapshot(id: string) {
    return (await (await this.request(`/api/conversations/${id}`)).json()) as Conversation;
  }
  /** Resolve an unknown tool outcome after checking the destination. Same auth as commands. */
  async resolveToolOutcome(id: string, execId: string, outcome: "applied" | "not-applied") {
    return (await (
      await this.request(
        `/api/conversations/${encodeURIComponent(id)}/ledger/${encodeURIComponent(execId)}/resolve`,
        { outcome },
      )
    ).json()) as Conversation;
  }
  async command(id: string, command: WireCommand) {
    // Caller retains the command ID across retries. Never regenerate it after a lost response.
    return (await (await this.request(`/api/conversations/${id}/commands`, command)).json()) as {
      accepted: boolean;
      jobId: string | null;
    };
  }
  async stream(id: string, after: number, receive: (event: Event) => void, signal: AbortSignal) {
    const response = await this.request(
      `/api/conversations/${id}/events?after=${after}`,
      undefined,
      signal,
    );
    const reader = response.body!.getReader(),
      decoder = new TextDecoder();
    let buffered = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffered.indexOf("\n\n")) >= 0) {
          const frame = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (data) receive(JSON.parse(data) as Event);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
