/**
 * The audience check: "who may see this thread's content". Its owner, plus members of the
 * thread's project while the project is live. There is no sensitivity state; what members see of
 * entitled tools' output is filtered separately (shared-threads.ts). Every surface that lets a
 * non-owner see a thread (member thread view, member previews) calls `require` or
 * `allowedAudience` first.
 *
 * On a deny nothing changes except a `share.denied` journal entry on the thread. The actor (the
 * owner) gets a 409; anyone else gets a 404, so a probe can't tell a foreign thread from a missing
 * one.
 */
import { ApiError, append, read, type Conversation, type Store } from "./store.ts";

export type Audience = { kind: "user"; userId: string } | { kind: "project"; projectId: string };

export interface MemberSource {
  /** Current members (any role) of a project; empty for a missing or archived project. */
  members(projectId: string): Promise<Iterable<string>>;
}

/** No projects: nobody is a member of anything. */
export const NO_PROJECTS: MemberSource = { members: async () => [] };

export class AudienceCheck {
  private cache = new Map<string, { members: ReadonlySet<string>; until: number }>();
  private readonly store: Store;
  private source: MemberSource;
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(
    store: Store,
    source: MemberSource = NO_PROJECTS,
    opts: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.store = store;
    this.source = source;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Late binding: the project service needs the check, the check needs its members. */
  useSource(source: MemberSource) {
    this.source = source;
    this.cache.clear();
  }
  /** Project members, cached briefly; membership changes and account deletion invalidate. */
  async resolveMembers(projectId: string): Promise<ReadonlySet<string>> {
    const hit = this.cache.get(projectId);
    if (hit && hit.until > this.now()) return hit.members;
    const members = new Set(await this.source.members(projectId));
    this.cache.set(projectId, { members, until: this.now() + this.ttlMs });
    return members;
  }
  /** Call on any membership change of this project (add, remove, role change, archive). */
  invalidateProject(projectId: string) {
    this.cache.delete(projectId);
  }
  /** Call when an account is deleted: it may be a member anywhere. */
  invalidateUser(_userId: string) {
    this.cache.clear();
  }

  /** Pure decision: may `audience` see `c`'s content? */
  async allowedAudience(c: Conversation, audience: Audience): Promise<boolean> {
    if (c.deletedAt) return false;
    if (audience.kind === "user" && audience.userId === c.owner) return true;
    if (!c.projectId) return false;
    if (audience.kind === "project") return audience.projectId === c.projectId;
    return (await this.resolveMembers(c.projectId)).has(audience.userId);
  }

  /**
   * Gate for a share-like action by `actor` on the owner's thread. Throws 409 (actor is the owner)
   * or 404 (anyone else) on deny, after journaling `share.denied`.
   */
  async require(
    actor: string,
    owner: string,
    id: string,
    audience: Audience,
    action: string,
  ): Promise<Conversation> {
    const c = await read(this.store, owner, id);
    if (await this.allowedAudience(c, audience)) return c;
    await this.store.mutate(owner, id, (conv) => {
      append(conv, "share.denied", {
        action,
        audience: audience.kind,
        byOwner: actor === owner,
      });
    });
    if (actor === owner)
      throw new ApiError(409, "This conversation can't be shared", "share_denied");
    throw new ApiError(404, "Conversation not found");
  }
}
