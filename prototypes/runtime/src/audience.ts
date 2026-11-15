/**
 * The audience check (V1.3; replaces the dropped L5 label-readers check).
 *
 * "Who may see this thread's content": its owner, plus (from V1.4) members of the thread's project,
 * and only while the thread is clean. A sensitive thread's content never goes to anyone but its
 * owner in v1: no share, invite, project-store grant or cross-thread surface. Every surface that
 * would let a non-owner see a thread (project views, invites, store grants) calls `require` first.
 *
 * On a deny nothing changes except a `share.denied` journal entry on the thread. The actor (the
 * owner trying to share) gets a 409 that does not say why; anyone else gets a 404, so a probe can't
 * tell a sensitive thread from a missing one.
 */
import { ApiError, append, read, type Conversation, type Store } from "./store.ts";

export type Audience = { kind: "user"; userId: string } | { kind: "project"; projectId: string };

export interface MemberSource {
  /** Current members (any role) of a project; empty for a missing or archived project. */
  members(projectId: string): Promise<Iterable<string>>;
}

/** No projects yet (before V1.4): nobody is a member of anything. */
export const NO_PROJECTS: MemberSource = { members: async () => [] };

export class AudienceCheck {
  private cache = new Map<string, { members: ReadonlySet<string>; until: number }>();
  private readonly store: Store;
  private readonly source: MemberSource;
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
    // A sensitive thread is never shared beyond its owner, whatever the membership.
    if (c.tainted) return false;
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
