/**
 * Projects, members and join links. A project groups its members' threads and a shared store.
 * Members can read each other's project threads read-only (shared-threads.ts, through the
 * audience check, with entitled tools' output hidden from members without the entitlement) and
 * open their shared previews. Conversation routes stay (owner, id)-scoped: a member never drives
 * another member's thread, terminal or sandbox.
 *
 * Always on (no flag). Join links default to the viewer role; an owner can mint an editor link.
 *
 * Roles: owner (membership, invites, join link, archive), editor (create threads in the project,
 * write the store), viewer (read the store and their own board; cannot create threads).
 * Every member- or role-gated route answers 404 to non-members (foreign resources don't exist)
 * and 403 to members whose role is too low.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AudienceCheck, MemberSource } from "./audience.ts";
import { ApiError, append, listAll, type Store } from "./store.ts";

export type ProjectRole = "owner" | "editor" | "viewer";
export interface ProjectRepoRef {
  provider: "github";
  owner: string;
  name: string;
}
export interface Project {
  id: string;
  name: string;
  /** Immutable creator. */
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
  repos: ProjectRepoRef[];
}
export interface ProjectMember {
  projectId: string;
  userId: string;
  role: ProjectRole;
  invitedBy: string;
  joinedAt: string;
}

/** Storage only; rules live in ProjectService. */
export interface ProjectStore {
  create(project: Project, owner: ProjectMember): Promise<void>;
  project(id: string): Promise<Project | undefined>;
  update(id: string, patch: Partial<Pick<Project, "name" | "repos" | "archivedAt">>): Promise<void>;
  projectsFor(userId: string): Promise<Array<{ project: Project; role: ProjectRole }>>;
  members(projectId: string): Promise<ProjectMember[]>;
  member(projectId: string, userId: string): Promise<ProjectMember | undefined>;
  /** false: already a member (unchanged). */
  addMember(member: ProjectMember): Promise<boolean>;
  setRole(projectId: string, userId: string, role: ProjectRole): Promise<void>;
  removeMember(projectId: string, userId: string): Promise<void>;
  /** Stores a new join token (hash) and revokes every earlier one for the project. */
  rotateJoinToken(
    projectId: string,
    hash: string,
    role: ProjectRole,
    createdBy: string,
  ): Promise<void>;
  joinToken(hash: string): Promise<{ projectId: string; role: ProjectRole } | undefined>;
  /** Account deletion: memberships and join tokens the user created. Returns affected projects. */
  removeUser(userId: string): Promise<string[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

// ---- in-memory (tests) ----------------------------------------------------------------------
export class MemoryProjects implements ProjectStore {
  private projects = new Map<string, Project>();
  private memberRows: ProjectMember[] = [];
  private tokens: Array<{
    hash: string;
    projectId: string;
    role: ProjectRole;
    createdBy: string;
    revoked: boolean;
  }> = [];
  async create(p: Project, owner: ProjectMember) {
    this.projects.set(p.id, clone(p));
    this.memberRows.push(clone(owner));
  }
  async project(id: string) {
    const p = this.projects.get(id);
    return p && clone(p);
  }
  async update(id: string, patch: Partial<Project>) {
    const p = this.projects.get(id);
    if (p) Object.assign(p, clone(patch));
  }
  async projectsFor(userId: string) {
    return this.memberRows
      .filter((m) => m.userId === userId)
      .map((m) => ({ project: clone(this.projects.get(m.projectId)!), role: m.role }));
  }
  async members(projectId: string) {
    return clone(this.memberRows.filter((m) => m.projectId === projectId));
  }
  async member(projectId: string, userId: string) {
    const m = this.memberRows.find((x) => x.projectId === projectId && x.userId === userId);
    return m && clone(m);
  }
  async addMember(m: ProjectMember) {
    if (await this.member(m.projectId, m.userId)) return false;
    this.memberRows.push(clone(m));
    return true;
  }
  async setRole(projectId: string, userId: string, role: ProjectRole) {
    const m = this.memberRows.find((x) => x.projectId === projectId && x.userId === userId);
    if (m) m.role = role;
  }
  async removeMember(projectId: string, userId: string) {
    this.memberRows = this.memberRows.filter(
      (x) => !(x.projectId === projectId && x.userId === userId),
    );
  }
  async rotateJoinToken(projectId: string, hash: string, role: ProjectRole, createdBy: string) {
    for (const t of this.tokens) if (t.projectId === projectId) t.revoked = true;
    this.tokens.push({ hash, projectId, role, createdBy, revoked: false });
  }
  async joinToken(hash: string) {
    const t = this.tokens.find((x) => x.hash === hash && !x.revoked);
    return t && { projectId: t.projectId, role: t.role };
  }
  async removeUser(userId: string) {
    const affected = this.memberRows.filter((m) => m.userId === userId).map((m) => m.projectId);
    this.memberRows = this.memberRows.filter((m) => m.userId !== userId);
    this.tokens = this.tokens.filter((t) => t.createdBy !== userId);
    return [...new Set(affected)];
  }
}

// ---- Postgres ---------------------------------------------------------------------------------
const projectRow = (r: Record<string, unknown>): Project => ({
  id: r.id as string,
  name: r.name as string,
  createdBy: r.created_by as string,
  createdAt: new Date(r.created_at as string).toISOString(),
  archivedAt: r.archived_at ? new Date(r.archived_at as string).toISOString() : null,
  repos: (r.repos as ProjectRepoRef[]) ?? [],
});
const memberRow = (r: Record<string, unknown>): ProjectMember => ({
  projectId: r.project_id as string,
  userId: r.user_id as string,
  role: r.role as ProjectRole,
  invitedBy: r.invited_by as string,
  joinedAt: new Date(r.joined_at as string).toISOString(),
});

export class PostgresProjects implements ProjectStore {
  private readonly pool: Pool;
  private constructor(pool: Pool) {
    this.pool = pool;
  }
  /** Needs Better Auth's "user" table (memberships cascade with the user row). */
  static async open(pool: Pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS prototype_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      archived_at TIMESTAMPTZ,
      repos JSONB NOT NULL DEFAULT '[]'::jsonb)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS prototype_project_members (
      project_id TEXT NOT NULL REFERENCES prototype_projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
      invited_by TEXT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, user_id))`);
    await pool.query(
      "CREATE INDEX IF NOT EXISTS prototype_project_members_user ON prototype_project_members (user_id)",
    );
    await pool.query(`CREATE TABLE IF NOT EXISTS prototype_project_join_tokens (
      hash TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES prototype_projects(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ)`);
    return new PostgresProjects(pool);
  }
  async create(p: Project, owner: ProjectMember) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO prototype_projects (id, name, created_by, created_at, repos) VALUES ($1,$2,$3,$4,$5)`,
        [p.id, p.name, p.createdBy, p.createdAt, JSON.stringify(p.repos)],
      );
      await c.query(
        `INSERT INTO prototype_project_members (project_id, user_id, role, invited_by, joined_at) VALUES ($1,$2,$3,$4,$5)`,
        [owner.projectId, owner.userId, owner.role, owner.invitedBy, owner.joinedAt],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async project(id: string) {
    const r = await this.pool.query("SELECT * FROM prototype_projects WHERE id=$1", [id]);
    return r.rows[0] ? projectRow(r.rows[0]) : undefined;
  }
  async update(id: string, patch: Partial<Pick<Project, "name" | "repos" | "archivedAt">>) {
    if (patch.name !== undefined)
      await this.pool.query("UPDATE prototype_projects SET name=$2 WHERE id=$1", [id, patch.name]);
    if (patch.repos !== undefined)
      await this.pool.query("UPDATE prototype_projects SET repos=$2 WHERE id=$1", [
        id,
        JSON.stringify(patch.repos),
      ]);
    if (patch.archivedAt !== undefined)
      await this.pool.query("UPDATE prototype_projects SET archived_at=$2 WHERE id=$1", [
        id,
        patch.archivedAt,
      ]);
  }
  async projectsFor(userId: string) {
    const r = await this.pool.query(
      `SELECT p.*, m.role FROM prototype_project_members m
       JOIN prototype_projects p ON p.id = m.project_id WHERE m.user_id=$1 ORDER BY p.created_at`,
      [userId],
    );
    return r.rows.map((row) => ({ project: projectRow(row), role: row.role as ProjectRole }));
  }
  async members(projectId: string) {
    const r = await this.pool.query(
      "SELECT * FROM prototype_project_members WHERE project_id=$1 ORDER BY joined_at",
      [projectId],
    );
    return r.rows.map(memberRow);
  }
  async member(projectId: string, userId: string) {
    const r = await this.pool.query(
      "SELECT * FROM prototype_project_members WHERE project_id=$1 AND user_id=$2",
      [projectId, userId],
    );
    return r.rows[0] ? memberRow(r.rows[0]) : undefined;
  }
  async addMember(m: ProjectMember) {
    const r = await this.pool.query(
      `INSERT INTO prototype_project_members (project_id, user_id, role, invited_by, joined_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, user_id) DO NOTHING`,
      [m.projectId, m.userId, m.role, m.invitedBy, m.joinedAt],
    );
    return r.rowCount === 1;
  }
  async setRole(projectId: string, userId: string, role: ProjectRole) {
    await this.pool.query(
      "UPDATE prototype_project_members SET role=$3 WHERE project_id=$1 AND user_id=$2",
      [projectId, userId, role],
    );
  }
  async removeMember(projectId: string, userId: string) {
    await this.pool.query(
      "DELETE FROM prototype_project_members WHERE project_id=$1 AND user_id=$2",
      [projectId, userId],
    );
  }
  async rotateJoinToken(projectId: string, hash: string, role: ProjectRole, createdBy: string) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "UPDATE prototype_project_join_tokens SET revoked_at=now() WHERE project_id=$1 AND revoked_at IS NULL",
        [projectId],
      );
      await c.query(
        "INSERT INTO prototype_project_join_tokens (hash, project_id, role, created_by) VALUES ($1,$2,$3,$4)",
        [hash, projectId, role, createdBy],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async joinToken(hash: string) {
    const r = await this.pool.query(
      "SELECT project_id, role FROM prototype_project_join_tokens WHERE hash=$1 AND revoked_at IS NULL",
      [hash],
    );
    const row = r.rows[0];
    return row ? { projectId: row.project_id as string, role: row.role as ProjectRole } : undefined;
  }
  async removeUser(userId: string) {
    const r = await this.pool.query(
      "DELETE FROM prototype_project_members WHERE user_id=$1 RETURNING project_id",
      [userId],
    );
    await this.pool.query("DELETE FROM prototype_project_join_tokens WHERE created_by=$1", [
      userId,
    ]);
    return [...new Set(r.rows.map((x) => x.project_id as string))];
  }
}

// ---- rules ------------------------------------------------------------------------------------
const NAME = (v: unknown) => {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 100)
    throw new ApiError(400, "Project name must be 1-100 characters");
  return v.trim();
};
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const REPOS = (v: unknown): ProjectRepoRef[] => {
  if (!Array.isArray(v) || v.length > 50) throw new ApiError(400, "repos must be a list (max 50)");
  return v.map((r) => {
    const o = r as Record<string, unknown>;
    if (
      !o ||
      (o.provider ?? "github") !== "github" ||
      typeof o.owner !== "string" ||
      typeof o.name !== "string" ||
      !REPO_PART.test(o.owner) ||
      !REPO_PART.test(o.name)
    )
      throw new ApiError(400, "Each repo needs a GitHub owner and name");
    return { provider: "github", owner: o.owner, name: o.name };
  });
};
const ROLE = (v: unknown): "editor" | "viewer" => {
  if (v === undefined) return "viewer";
  if (v !== "editor" && v !== "viewer")
    throw new ApiError(400, 'role must be "editor" or "viewer"');
  return v;
};
export const hashJoinToken = (token: string) =>
  createHash("sha256").update(`linguini-join:${token}`).digest("hex");

export interface ProjectServiceOptions {
  store: Store;
  audience?: AudienceCheck;
  /** Resolves a user id or an email to a user on this deployment (Better Auth); undefined: none. */
  lookupUser(ref: { userId?: string; email?: string }): Promise<string | undefined>;
  now?: () => Date;
  newId?: () => string;
}

export class ProjectService {
  readonly repo: ProjectStore;
  private readonly o: ProjectServiceOptions;
  constructor(repo: ProjectStore, options: ProjectServiceOptions) {
    this.repo = repo;
    this.o = options;
  }
  private now() {
    return (this.o.now?.() ?? new Date()).toISOString();
  }
  /** Members of live projects, for the audience check (archived projects have no audience). */
  memberSource(): MemberSource {
    return {
      members: async (projectId) => {
        const p = await this.repo.project(projectId);
        if (!p || p.archivedAt) return [];
        return (await this.repo.members(projectId)).map((m) => m.userId);
      },
    };
  }
  /** The caller's membership; 404 for non-members and missing projects alike. */
  private async membership(actor: string, projectId: string, roles?: ProjectRole[]) {
    const [project, member] = await Promise.all([
      this.repo.project(projectId),
      this.repo.member(projectId, actor),
    ]);
    if (!project || !member) throw new ApiError(404, "Project not found");
    if (roles && !roles.includes(member.role))
      throw new ApiError(403, `This needs the ${roles.join(" or ")} role in the project`);
    return { project, member };
  }
  private changed(projectId: string) {
    this.o.audience?.invalidateProject(projectId);
  }

  async list(actor: string) {
    return (await this.repo.projectsFor(actor))
      .filter((x) => !x.project.archivedAt)
      .map((x) => ({ ...x.project, role: x.role }));
  }
  async create(actor: string, input: Record<string, unknown>) {
    const createdAt = this.now();
    const project: Project = {
      id: this.o.newId?.() ?? `p_${randomUUID().replace(/-/g, "")}`,
      name: NAME(input.name),
      createdBy: actor,
      createdAt,
      archivedAt: null,
      repos: input.repos === undefined ? [] : REPOS(input.repos),
    };
    await this.repo.create(project, {
      projectId: project.id,
      userId: actor,
      role: "owner",
      invitedBy: actor,
      joinedAt: createdAt,
    });
    return { ...project, role: "owner" as const };
  }
  async get(actor: string, id: string) {
    const { project, member } = await this.membership(actor, id);
    return { ...project, role: member.role };
  }
  async update(actor: string, id: string, input: Record<string, unknown>) {
    await this.membership(actor, id, ["owner"]);
    for (const k of Object.keys(input))
      if (!["name", "repos", "archived"].includes(k))
        throw new ApiError(400, `Unknown project field: ${k}`);
    if (input.archived !== undefined && typeof input.archived !== "boolean")
      throw new ApiError(400, "archived must be true or false");
    await this.repo.update(id, {
      ...(input.name !== undefined ? { name: NAME(input.name) } : {}),
      ...(input.repos !== undefined ? { repos: REPOS(input.repos) } : {}),
      ...(input.archived !== undefined ? { archivedAt: input.archived ? this.now() : null } : {}),
    });
    this.changed(id);
    return this.get(actor, id);
  }
  async members(actor: string, id: string) {
    await this.membership(actor, id);
    return (await this.repo.members(id)).map(({ userId, role, joinedAt }) => ({
      userId,
      role,
      joinedAt,
    }));
  }
  /** Owner adds an existing user of this deployment (by id or email) as editor or viewer. */
  async invite(actor: string, id: string, input: Record<string, unknown>) {
    const { project } = await this.membership(actor, id, ["owner"]);
    if (project.archivedAt) throw new ApiError(409, "The project is archived");
    const role = ROLE(input.role);
    const ref = {
      ...(typeof input.userId === "string" ? { userId: input.userId } : {}),
      ...(typeof input.email === "string" ? { email: input.email.trim().toLowerCase() } : {}),
    };
    if (!ref.userId && !ref.email) throw new ApiError(400, "Invite needs a userId or email");
    // Only users who already have an account here (D8): no accounts created by invitation.
    const userId = await this.o.lookupUser(ref);
    if (!userId) throw new ApiError(404, "No user with that account on this server");
    const added = await this.repo.addMember({
      projectId: id,
      userId,
      role,
      invitedBy: actor,
      joinedAt: this.now(),
    });
    if (!added) throw new ApiError(409, "Already a member");
    this.changed(id);
    return { userId, role };
  }
  /**
   * Owner removes a member, or a member leaves. Their threads stay theirs, detached from the
   * project (V1.5: they lose store mounts). A sole owner cannot leave or be removed.
   */
  async remove(actor: string, id: string, userId: string) {
    const { member } = await this.membership(actor, id);
    if (actor !== userId && member.role !== "owner")
      throw new ApiError(403, "Only a project owner can remove members");
    const target = await this.repo.member(id, userId);
    if (!target) throw new ApiError(404, "Not a member");
    if (target.role === "owner") {
      const owners = (await this.repo.members(id)).filter((m) => m.role === "owner");
      if (owners.length <= 1)
        throw new ApiError(409, "The only owner cannot leave or be removed; archive the project");
    }
    await this.repo.removeMember(id, userId);
    this.changed(id);
    const detached = await this.detachThreads(userId, id);
    return { removed: userId, detachedThreads: detached };
  }
  private async detachThreads(userId: string, projectId: string) {
    let n = 0;
    for await (const c of listAll(this.o.store, userId))
      if (c.projectId === projectId) {
        await this.o.store.mutate(userId, c.id, (conv) => {
          delete conv.projectId;
          append(conv, "project.detached", { projectId });
        });
        n++;
      }
    return n;
  }
  /** Owner mints or rotates the join link; earlier links stop working, members stay. */
  async rotateJoinLink(actor: string, id: string, input: Record<string, unknown>) {
    const { project } = await this.membership(actor, id, ["owner"]);
    if (project.archivedAt) throw new ApiError(409, "The project is archived");
    const role = ROLE(input.role);
    const token = randomBytes(24).toString("base64url");
    await this.repo.rotateJoinToken(id, hashJoinToken(token), role, actor);
    return { token, role, path: `/join/${token}` };
  }
  /** A signed-in user accepts a join link. 404 for unknown, rotated or archived. */
  async join(actor: string, token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new ApiError(404, "Invite not found");
    const t = await this.repo.joinToken(hashJoinToken(token));
    const project = t && (await this.repo.project(t.projectId));
    if (!t || !project || project.archivedAt) throw new ApiError(404, "Invite not found");
    // Membership is the audience: from here on the member may read the project's threads.
    await this.repo.addMember({
      projectId: t.projectId,
      userId: actor,
      role: t.role,
      invitedBy: project.createdBy,
      joinedAt: this.now(),
    });
    this.changed(t.projectId);
    return this.get(actor, t.projectId);
  }
  /** The project's threads: the caller's own and (read-only) every other member's. */
  async threads(actor: string, id: string) {
    await this.membership(actor, id);
    const out = [];
    for (const m of await this.repo.members(id))
      for await (const c of listAll(this.o.store, m.userId))
        if (c.projectId === id && !c.deletedAt)
          out.push({
            id: c.id,
            owner: c.owner,
            mine: c.owner === actor,
            title: c.title,
            updatedAt: c.updatedAt ?? null,
            settledAt: c.metadata?.settledAt ?? null,
            archivedAt: c.metadata?.archivedAt ?? null,
          });
    return out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }
  /** POST /api/conversations with projectId: editor or owner of a live project. */
  async assertCanCreateThread(actor: string, projectId: unknown) {
    if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(projectId))
      throw new ApiError(400, "Invalid project ID");
    const { project } = await this.membership(actor, projectId, ["owner", "editor"]);
    if (project.archivedAt) throw new ApiError(409, "The project is archived");
    return projectId;
  }
  /**
   * Account deletion: drop memberships and the links they minted. A project left without an
   * owner is archived (its other members keep their threads; nobody can administer it).
   */
  async removeUser(userId: string) {
    const affected = await this.repo.removeUser(userId);
    for (const id of affected) {
      const owners = (await this.repo.members(id)).filter((m) => m.role === "owner");
      const p = await this.repo.project(id);
      if (p && !p.archivedAt && !owners.length)
        await this.repo.update(id, { archivedAt: this.now() });
    }
    this.o.audience?.invalidateUser(userId);
    return affected;
  }
}
