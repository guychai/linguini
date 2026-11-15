/**
 * Entitlements (V1.6a; spec §10.1): who may use which tool, MCP server or scope.
 *
 * Rules are (subject × object × effect). Subjects: the org, a project, a role (Better Auth role,
 * "admin" / "user") or a user. Objects: `tool:<name>`, `mcp:<server>`, `scope:<name>`.
 * Evaluation, after the platform's hard denies (undeclared destination, sensitive boundary):
 * org deny > project deny > role/user deny > the most specific allow (user > role > org).
 * Gated objects (trino_query, github_create_pr, every MCP server, scope github_read) are denied
 * without an allow; everything else (built-in sandbox tools) is allowed unless denied.
 * Projects can only narrow: a project rule is always a deny.
 *
 * Enforced only with ENTITLEMENTS=1 (off by default; Nick to OK). The rule set is small, so the
 * service keeps it in memory (reloaded on every change and periodically) and answers
 * synchronously, which the egress placement (GitHub reads) needs.
 *
 * Bootstrap for one release: GITHUB_APP_OWNERS still grants scope github_read and
 * GITHUB_PUBLISH_OWNERS still grants tool github_create_pr to the users listed.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError } from "./store.ts";

export type Subject =
  | { type: "org" }
  | { type: "project"; id: string }
  | { type: "role"; id: string }
  | { type: "user"; id: string };
export type EntObject =
  { type: "tool"; name: string } | { type: "mcp"; name: string } | { type: "scope"; name: string };
export type Effect = "allow" | "deny";
export interface Rule {
  subject: Subject;
  object: EntObject;
  effect: Effect;
}
export interface Who {
  userId: string;
  role?: string;
  projectId?: string;
}

const GATED_TOOLS = new Set(["trino_query", "github_create_pr"]);
const GATED_SCOPES = new Set(["github_read"]);
export const isGated = (o: EntObject) =>
  o.type === "mcp" ||
  (o.type === "tool" && GATED_TOOLS.has(o.name)) ||
  (o.type === "scope" && GATED_SCOPES.has(o.name));

const sameObject = (a: EntObject, b: EntObject) =>
  a.type === b.type && (a.name === b.name || (a.type === "mcp" && a.name === "*"));

export type Decision = { allowed: boolean; reason: string };

/** Pure evaluation over a rule set. */
export function evaluate(rules: readonly Rule[], who: Who, object: EntObject): Decision {
  const hits = rules.filter((r) => sameObject(r.object, object));
  const by = (pred: (s: Subject) => boolean, effect: Effect) =>
    hits.some((r) => r.effect === effect && pred(r.subject));
  const org = (s: Subject) => s.type === "org";
  const project = (s: Subject) => s.type === "project" && s.id === who.projectId;
  const role = (s: Subject) => s.type === "role" && s.id === who.role;
  const user = (s: Subject) => s.type === "user" && s.id === who.userId;
  if (by(org, "deny")) return { allowed: false, reason: "org-deny" };
  if (who.projectId && by(project, "deny")) return { allowed: false, reason: "project-deny" };
  if (by((s) => role(s) || user(s), "deny")) return { allowed: false, reason: "user-deny" };
  if (by(user, "allow")) return { allowed: true, reason: "user-allow" };
  if (by(role, "allow")) return { allowed: true, reason: "role-allow" };
  if (by(org, "allow")) return { allowed: true, reason: "org-allow" };
  return isGated(object)
    ? { allowed: false, reason: "no-entitlement" }
    : { allowed: true, reason: "default" };
}

const NAME = /^[A-Za-z0-9_.:*-]{1,100}$/;
export function parseRule(input: unknown, scope: "admin" | { projectId: string }): Rule {
  const o = (input ?? {}) as Record<string, any>;
  const object = o.object ?? {};
  if (!["tool", "mcp", "scope"].includes(object.type) || !NAME.test(String(object.name ?? "")))
    throw new ApiError(400, "Each rule needs object {type: tool|mcp|scope, name}");
  if (object.name === "*" && object.type !== "mcp")
    throw new ApiError(400, 'Only mcp objects take the "*" wildcard');
  if (o.effect !== "allow" && o.effect !== "deny")
    throw new ApiError(400, 'effect must be "allow" or "deny"');
  if (scope !== "admin") {
    // Project owners can only narrow what the org allows.
    if (o.effect !== "deny") throw new ApiError(400, "Project rules can only deny");
    return {
      subject: { type: "project", id: scope.projectId },
      object: { type: object.type, name: object.name },
      effect: "deny",
    };
  }
  const s = o.subject ?? {};
  let subject: Subject;
  if (s.type === "org") subject = { type: "org" };
  else if ((s.type === "role" || s.type === "user") && typeof s.id === "string" && NAME.test(s.id))
    subject = { type: s.type, id: s.id };
  else throw new ApiError(400, "subject must be {type: org} or {type: role|user, id}");
  return { subject, object: { type: object.type, name: object.name }, effect: o.effect };
}

// ---- storage -------------------------------------------------------------------------------
export interface RuleStore {
  all(): Promise<Rule[]>;
  /** Replaces every rule whose subject is in `scope` (admin: org/role/user; or one project). */
  replace(scope: "admin" | { projectId: string }, rules: Rule[], by: string): Promise<void>;
  /** Account deletion: drop that user's rules. */
  removeUser(userId: string): Promise<void>;
}
const inScope = (s: Subject, scope: "admin" | { projectId: string }) =>
  scope === "admin" ? s.type !== "project" : s.type === "project" && s.id === scope.projectId;

export class MemoryRules implements RuleStore {
  private rules: Rule[] = [];
  async all() {
    return structuredClone(this.rules);
  }
  async replace(scope: "admin" | { projectId: string }, rules: Rule[]) {
    this.rules = [
      ...this.rules.filter((r) => !inScope(r.subject, scope)),
      ...structuredClone(rules),
    ];
  }
  async removeUser(userId: string) {
    this.rules = this.rules.filter((r) => !(r.subject.type === "user" && r.subject.id === userId));
  }
}

export class PostgresRules implements RuleStore {
  private readonly pool: Pool;
  private constructor(pool: Pool) {
    this.pool = pool;
  }
  static async open(pool: Pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS prototype_entitlements (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('org','project','role','user')),
      subject_id TEXT NOT NULL DEFAULT '',
      object_type TEXT NOT NULL CHECK (object_type IN ('tool','mcp','scope')),
      object_name TEXT NOT NULL,
      effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    return new PostgresRules(pool);
  }
  async all() {
    const r = await this.pool.query("SELECT * FROM prototype_entitlements ORDER BY created_at, id");
    return r.rows.map((x): Rule => ({
      subject:
        x.subject_type === "org" ? { type: "org" } : { type: x.subject_type, id: x.subject_id },
      object: { type: x.object_type, name: x.object_name },
      effect: x.effect,
    }));
  }
  async replace(scope: "admin" | { projectId: string }, rules: Rule[], by: string) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      if (scope === "admin")
        await c.query("DELETE FROM prototype_entitlements WHERE subject_type <> 'project'");
      else
        await c.query(
          "DELETE FROM prototype_entitlements WHERE subject_type = 'project' AND subject_id = $1",
          [scope.projectId],
        );
      for (const r of rules)
        await c.query(
          `INSERT INTO prototype_entitlements (id, subject_type, subject_id, object_type, object_name, effect, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            r.subject.type,
            r.subject.type === "org" ? "" : r.subject.id,
            r.object.type,
            r.object.name,
            r.effect,
            by,
          ],
        );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async removeUser(userId: string) {
    await this.pool.query(
      "DELETE FROM prototype_entitlements WHERE subject_type='user' AND subject_id=$1",
      [userId],
    );
  }
}

// ---- service -------------------------------------------------------------------------------
export class Entitlements {
  private rules: Rule[] = [];
  private readonly roles = new Map<string, string>();
  private readonly store: RuleStore;
  private readonly bootstrap: { githubRead: ReadonlySet<string>; publish: ReadonlySet<string> };
  private timer?: NodeJS.Timeout;
  private readonly loadRoles?: () => Promise<Iterable<[string, string]>>;
  constructor(
    store: RuleStore,
    bootstrap: { githubRead?: Iterable<string>; publish?: Iterable<string> } = {},
    /** Every user's role (Better Auth "user".role), reloaded with the rules. */
    loadRoles?: () => Promise<Iterable<[string, string]>>,
  ) {
    this.store = store;
    this.loadRoles = loadRoles;
    this.bootstrap = {
      githubRead: new Set(bootstrap.githubRead ?? []),
      publish: new Set(bootstrap.publish ?? []),
    };
  }
  async load() {
    this.rules = await this.store.all();
    if (this.loadRoles) for (const [id, role] of await this.loadRoles()) this.roles.set(id, role);
    return this;
  }
  /** Reload periodically (another backend process, a manual SQL change). */
  start(ms = 60_000) {
    this.timer = setInterval(() => void this.load().catch(() => {}), ms);
    this.timer.unref();
    return this;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  /** Better Auth role, recorded as users authenticate (role subjects need it). */
  noteRole(userId: string, role: string | undefined) {
    if (role) this.roles.set(userId, role);
  }
  decide(userId: string, object: EntObject, projectId?: string): Decision {
    const who: Who = {
      userId,
      ...(this.roles.get(userId) ? { role: this.roles.get(userId)! } : {}),
      ...(projectId ? { projectId } : {}),
    };
    const d = evaluate(this.rules, who, object);
    if (!d.allowed && d.reason === "no-entitlement") {
      if (
        object.type === "scope" &&
        object.name === "github_read" &&
        this.bootstrap.githubRead.has(userId)
      )
        return { allowed: true, reason: "bootstrap-env" };
      if (
        object.type === "tool" &&
        object.name === "github_create_pr" &&
        this.bootstrap.publish.has(userId)
      )
        return { allowed: true, reason: "bootstrap-env" };
    }
    return d;
  }
  allowed(userId: string, object: EntObject, projectId?: string) {
    return this.decide(userId, object, projectId).allowed;
  }
  /** Broker hook: refuse a tool call the owner isn't entitled to. */
  assertTool(userId: string, tool: string, projectId?: string) {
    const d = this.decide(userId, { type: "tool", name: tool }, projectId);
    if (!d.allowed)
      throw new ApiError(
        403,
        d.reason === "no-entitlement"
          ? `"${tool}" is not enabled for your account`
          : `"${tool}" is disabled by your admin`,
        "entitlement_denied",
      );
  }
  adminRules() {
    return this.rules.filter((r) => r.subject.type !== "project");
  }
  projectRules(projectId: string) {
    return this.rules.filter((r) => r.subject.type === "project" && r.subject.id === projectId);
  }
  async replace(scope: "admin" | { projectId: string }, input: unknown, by: string) {
    if (!Array.isArray(input) || input.length > 500)
      throw new ApiError(400, "rules must be a list (max 500)");
    const rules = input.map((r) => parseRule(r, scope));
    await this.store.replace(scope, rules, by);
    await this.load();
    return scope === "admin" ? this.adminRules() : this.projectRules(scope.projectId);
  }
  /** What the user's own threads may use (outside any project). */
  mine(userId: string, tools: readonly string[]) {
    return {
      tools: tools.map((name) => {
        const d = this.decide(userId, { type: "tool", name });
        return {
          name,
          allowed: d.allowed,
          status: d.allowed
            ? "enabled"
            : d.reason === "no-entitlement"
              ? "not-enabled"
              : "disabled-by-admin",
        };
      }),
      githubRead: this.allowed(userId, { type: "scope", name: "github_read" }),
    };
  }
  async removeUser(userId: string) {
    await this.store.removeUser(userId);
    this.roles.delete(userId);
    await this.load();
  }
}
