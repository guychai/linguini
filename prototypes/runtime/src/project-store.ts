/**
 * Project store (V1.5; spec §9): project-scoped text artifacts (docs, notes, skills) that members
 * copy into their own private threads. Copy-on-grant: the sandbox gets a snapshot under
 * /workspace/.project/<name>, never a live mount of the project volume.
 *
 * The sensitive flag travels with the copy: granting a sensitive artifact sets the destination
 * thread's flag first (committed and journaled) and only then writes the file, so no byte of it is
 * ever visible in a clean thread (AM1.3). A sensitive thread may read from the store but never
 * write back to it (AM1.4); refusals are journaled as `store.denied` on the source thread.
 *
 * Removing a member stops future grants (membership is checked per grant); files already copied
 * stay in the thread, since the reader was entitled when they got them. Archived projects take
 * no writes or grants. Off with projects (PROJECTS=1).
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ProjectService } from "./projects.ts";
import { ApiError, append, read, type Store } from "./store.ts";

export const ARTIFACT_MAX_BYTES = 1024 * 1024;
export const GRANT_DIR = ".project";
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

export interface Artifact {
  id: string;
  projectId: string;
  name: string;
  sensitive: boolean;
  content: string;
  createdBy: string;
  createdAt: string;
}
export type ArtifactSummary = Omit<Artifact, "content"> & { bytes: number };

export interface ArtifactStore {
  put(a: Artifact): Promise<void>;
  get(projectId: string, id: string): Promise<Artifact | undefined>;
  list(projectId: string): Promise<ArtifactSummary[]>;
  remove(projectId: string, id: string): Promise<void>;
}

const summary = ({ content, ...rest }: Artifact): ArtifactSummary => ({
  ...rest,
  bytes: Buffer.byteLength(content),
});

export class MemoryArtifacts implements ArtifactStore {
  private rows = new Map<string, Artifact>();
  async put(a: Artifact) {
    for (const [k, v] of this.rows)
      if (v.projectId === a.projectId && v.name === a.name) this.rows.delete(k);
    this.rows.set(a.id, structuredClone(a));
  }
  async get(projectId: string, id: string) {
    const a = this.rows.get(id);
    return a && a.projectId === projectId ? structuredClone(a) : undefined;
  }
  async list(projectId: string) {
    return [...this.rows.values()].filter((a) => a.projectId === projectId).map(summary);
  }
  async remove(projectId: string, id: string) {
    if (this.rows.get(id)?.projectId === projectId) this.rows.delete(id);
  }
}

export class PostgresArtifacts implements ArtifactStore {
  private readonly pool: Pool;
  private constructor(pool: Pool) {
    this.pool = pool;
  }
  /** Needs prototype_projects (PostgresProjects.open first). */
  static async open(pool: Pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS prototype_project_store (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES prototype_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sensitive BOOLEAN NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, name))`);
    return new PostgresArtifacts(pool);
  }
  private row(r: Record<string, unknown>): Artifact {
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      name: r.name as string,
      sensitive: r.sensitive as boolean,
      content: (r.content as string) ?? "",
      createdBy: r.created_by as string,
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }
  async put(a: Artifact) {
    // Same name replaces the entry (new id, new flag: a sensitive version never inherits "clean").
    await this.pool.query(
      `INSERT INTO prototype_project_store (id, project_id, name, sensitive, content, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (project_id, name) DO UPDATE SET id=EXCLUDED.id, sensitive=EXCLUDED.sensitive,
         content=EXCLUDED.content, created_by=EXCLUDED.created_by, created_at=EXCLUDED.created_at`,
      [a.id, a.projectId, a.name, a.sensitive, a.content, a.createdBy, a.createdAt],
    );
  }
  async get(projectId: string, id: string) {
    const r = await this.pool.query(
      "SELECT * FROM prototype_project_store WHERE project_id=$1 AND id=$2",
      [projectId, id],
    );
    return r.rows[0] ? this.row(r.rows[0]) : undefined;
  }
  async list(projectId: string) {
    const r = await this.pool.query(
      `SELECT id, project_id, name, sensitive, created_by, created_at, octet_length(content) AS bytes
       FROM prototype_project_store WHERE project_id=$1 ORDER BY name`,
      [projectId],
    );
    return r.rows.map((x) => ({
      ...this.row({ ...x, content: "" }),
      bytes: Number(x.bytes),
    })) as ArtifactSummary[];
  }
  async remove(projectId: string, id: string) {
    await this.pool.query("DELETE FROM prototype_project_store WHERE project_id=$1 AND id=$2", [
      projectId,
      id,
    ]);
  }
}

/** The conversation sandbox side: read a file (write-back), write a granted copy. */
export interface ThreadFiles {
  read(owner: string, id: string, path: string): Promise<string>;
  /** Writes /workspace/.project/<name> (creating the directory), replacing any earlier copy. */
  put(owner: string, id: string, name: string, content: string): Promise<void>;
}

export class ProjectArtifacts {
  private readonly o: {
    store: Store;
    projects: ProjectService;
    artifacts: ArtifactStore;
    files?: ThreadFiles;
    now?: () => Date;
  };
  constructor(o: ProjectArtifacts["o"]) {
    this.o = o;
  }
  private now() {
    return (this.o.now?.() ?? new Date()).toISOString();
  }
  private files() {
    if (!this.o.files)
      throw new ApiError(501, "Thread files are not available on this node", "not_implemented");
    return this.o.files;
  }
  private async live(actor: string, projectId: string, roles?: Array<"owner" | "editor">) {
    const p = await this.o.projects.get(actor, projectId);
    if (roles && !roles.includes(p.role as "owner" | "editor"))
      throw new ApiError(403, "Only project editors and owners can change the store");
    if (p.archivedAt) throw new ApiError(409, "The project is archived");
    return p;
  }

  async list(actor: string, projectId: string) {
    await this.o.projects.get(actor, projectId);
    return this.o.artifacts.list(projectId);
  }

  /**
   * Editor/owner writes an artifact: `{name, content, sensitive?}` typed in the UI, or
   * `{name?, conversationId, path}` copied from one of the caller's own threads. A sensitive
   * thread can never be the source (AM1.4), and its copy inherits nothing: the source is checked
   * before and after the read so a thread that turns sensitive mid-copy is refused too.
   */
  async write(actor: string, projectId: string, input: Record<string, unknown>) {
    await this.live(actor, projectId, ["owner", "editor"]);
    let content: string;
    let sensitive = input.sensitive === true;
    let name = input.name;
    if (typeof input.conversationId === "string") {
      const source = input.conversationId;
      if (typeof input.path !== "string") throw new ApiError(400, "path is required");
      const refuse = async () => {
        await this.o.store.mutate(actor, source, (c) => {
          append(c, "store.denied", { projectId, reason: "sensitive-source" });
        });
        return new ApiError(
          409,
          "A conversation with sensitive data can't write to the project store",
          "store_sensitive_source",
        );
      };
      if ((await read(this.o.store, actor, source)).tainted) throw await refuse();
      content = await this.files().read(actor, source, input.path);
      if ((await read(this.o.store, actor, source)).tainted) throw await refuse();
      name ??= input.path.split("/").at(-1);
      sensitive = false;
    } else if (typeof input.content === "string") content = input.content;
    else throw new ApiError(400, "Provide content, or conversationId and path");
    if (typeof name !== "string" || !NAME.test(name))
      throw new ApiError(400, "Artifact name: letters, digits, . _ - (max 100, no leading dot)");
    if (Buffer.byteLength(content) > ARTIFACT_MAX_BYTES)
      throw new ApiError(413, "Artifact too large (limit 1 MiB)");
    const artifact: Artifact = {
      id: `a_${randomUUID().replace(/-/g, "")}`,
      projectId,
      name,
      sensitive,
      content,
      createdBy: actor,
      createdAt: this.now(),
    };
    await this.o.artifacts.put(artifact);
    return summary(artifact);
  }

  async remove(actor: string, projectId: string, artifactId: string) {
    const p = await this.o.projects.get(actor, projectId);
    const a = await this.o.artifacts.get(projectId, artifactId);
    if (!a) throw new ApiError(404, "Artifact not found");
    if (p.role !== "owner" && a.createdBy !== actor)
      throw new ApiError(403, "Only the project owner or the artifact's author can delete it");
    await this.o.artifacts.remove(projectId, artifactId);
    return { deleted: artifactId };
  }

  /**
   * Copies an artifact into one of the caller's own threads in the project. Order (AM1.3):
   * membership and thread checks, then (sensitive artifact) the thread's flag is committed, then
   * the file is written, then `store.granted` is journaled.
   */
  async grant(actor: string, conversationId: string, input: Record<string, unknown>) {
    if (typeof input.artifactId !== "string") throw new ApiError(400, "artifactId is required");
    const c = await read(this.o.store, actor, conversationId);
    if (!c.projectId) throw new ApiError(409, "This conversation is not in a project");
    await this.live(actor, c.projectId);
    const a = await this.o.artifacts.get(c.projectId, input.artifactId);
    if (!a) throw new ApiError(404, "Artifact not found");
    const files = this.files();
    if (a.sensitive)
      await this.o.store.mutate(actor, conversationId, (conv) => {
        if (conv.tainted) return;
        conv.tainted = true;
        append(conv, "taint.changed", {
          tainted: true,
          reason: "store.grant",
          artifactId: a.id,
        });
      });
    await files.put(actor, conversationId, a.name, a.content);
    await this.o.store.mutate(actor, conversationId, (conv) => {
      append(conv, "store.granted", {
        projectId: a.projectId,
        artifactId: a.id,
        name: a.name,
        sensitive: a.sensitive,
        path: `${GRANT_DIR}/${a.name}`,
      });
    });
    return { path: `${GRANT_DIR}/${a.name}`, sensitive: a.sensitive };
  }
}

/** Bash for ThreadFiles.put over hands exec: content on stdin, atomic rename into .project/. */
export const GRANT_SCRIPT = String.raw`set -eu
name="$1"
root="$2"
[ -n "$root" ] || root=/workspace
case "$name" in */*|.*|"") echo "bad name" >&2; exit 2;; esac
cd -- "$root"
[ -L .project ] && { echo ".project is a symlink" >&2; exit 3; }
mkdir -p .project
tmp=$(mktemp .project/.grant.XXXXXX)
cat > "$tmp"
chmod 0644 "$tmp"
mv -f -T "$tmp" ".project/$name"
`;
