/**
 * Read-only view of a project thread for the project's members (the owner uses the normal
 * conversation routes). Access is the audience check: the viewer must be a member of the thread's
 * live project. Nothing here can drive the thread.
 *
 * Entitled tools' output is hidden from members who lack the entitlement (approved default: Trino
 * output in shared threads is hidden from members without `trino_query`). A turn that called such
 * a tool is reduced to the user's prompt and the run's status: the tool's arguments and output and
 * the assistant's text in that turn are replaced by `{ hidden: true }` stubs, since the answer
 * usually restates the rows.
 */
import type { AudienceCheck } from "./audience.ts";
import { read, type Conversation, type Store } from "./store.ts";

/** Tools whose output only entitled members may see in someone else's thread. */
export const ENTITLED_OUTPUT_TOOLS: readonly string[] = ["trino_query"];

/** Event types that never carry tool output or model text. */
const SAFE_TYPES = new Set([
  "message.user",
  "message.edited",
  "run.queued",
  "run.queue.reordered",
  "run.started",
  "run.completed",
  "run.cancelled",
  "run.interrupted",
  "run.blocked",
  "steering.accepted",
  "steering.rejected",
  "steering.interrupted",
]);

type Event = Conversation["events"][number];

/** The events a viewer may see; `visible(tool)` says whether they may see that tool's output. */
export function redactEvents(events: readonly Event[], visible: (tool: string) => boolean) {
  const hiddenTool = (t: unknown) =>
    typeof t === "string" && ENTITLED_OUTPUT_TOOLS.includes(t) && !visible(t);
  const hiddenJobs = new Set<string>();
  for (const e of events)
    if (hiddenTool(e.data.tool) && typeof e.data.jobId === "string") hiddenJobs.add(e.data.jobId);
  const out = events.map((e): Event => {
    const inHiddenJob = typeof e.data.jobId === "string" && hiddenJobs.has(e.data.jobId);
    if (!(inHiddenJob || hiddenTool(e.data.tool)) || SAFE_TYPES.has(e.type)) return e;
    return {
      ...e,
      data: {
        ...(typeof e.data.jobId === "string" ? { jobId: e.data.jobId } : {}),
        ...(typeof e.data.tool === "string" ? { tool: e.data.tool } : {}),
        hidden: true,
      },
    };
  });
  return { events: out, hiddenJobs: [...hiddenJobs] };
}

export class SharedThreads {
  constructor(
    private readonly o: {
      store: Store;
      audience: AudienceCheck;
      /** Whether `viewer` may see `tool`'s output in a thread of `projectId`. */
      canSee(viewer: string, tool: string, projectId: string): boolean;
    },
  ) {}
  /** 404 unless the viewer owns the thread or is a member of its live project. */
  async view(viewer: string, owner: string, id: string) {
    await this.o.audience.require(viewer, owner, id, { kind: "user", userId: viewer }, "view");
    const c = await read(this.o.store, owner, id);
    const projectId = c.projectId ?? "";
    const { events, hiddenJobs } =
      viewer === owner
        ? { events: c.events, hiddenJobs: [] as string[] }
        : redactEvents(c.events, (tool) => this.o.canSee(viewer, tool, projectId));
    return {
      id: c.id,
      owner: c.owner,
      projectId: c.projectId ?? null,
      title: c.title,
      readOnly: viewer !== owner,
      jobs: c.jobs.map((j) => ({ id: j.id, text: j.text, status: j.status })),
      events,
      hiddenJobs,
    };
  }
  /** For member previews: the thread's owner when `viewer` may see it, else undefined. */
  async allowed(viewer: string, owner: string, id: string) {
    try {
      const c = await read(this.o.store, owner, id);
      return (await this.o.audience.allowedAudience(c, { kind: "user", userId: viewer }))
        ? owner
        : undefined;
    } catch {
      return undefined;
    }
  }
}
