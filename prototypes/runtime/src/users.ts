/**
 * Per-user settings. Users themselves are Better Auth users (auth.ts); the conversation owner
 * is the Better Auth user id.
 */
import type { Pool } from "pg";
import { ApiError } from "./store.ts";

export interface UserSettings {
  model?: string;
  thinkingLevel?: string;
  prefs?: Record<string, unknown>;
}
export interface SettingsStore {
  settings(userId: string): Promise<UserSettings>;
  saveSettings(userId: string, settings: UserSettings): Promise<UserSettings>;
  deleteSettings(userId: string): Promise<void>;
}

// ---- settings validation ----------------------------------------------------------------
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export interface SettingsPolicy {
  models: readonly string[];
  thinkingLevels: readonly string[];
}
export function settingsPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SettingsPolicy {
  const configured = env.PI_MODEL ?? "claude-sonnet-4-5";
  const extra = (env.ALLOWED_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { models: [...new Set([configured, ...extra])], thinkingLevels: THINKING_LEVELS };
}
/**
 * Validates a settings update. Only `prefs` (UI preferences such as the theme) is user-settable:
 * the model and thinking level are fixed by the server (PI_MODEL / PI_THINKING_LEVEL) for
 * everyone, so `model` / `thinkingLevel` are refused. null clears prefs.
 */
export function validateSettings(
  input: unknown,
  current: UserSettings,
  _policy: SettingsPolicy,
): UserSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError(400, "Settings must be an object");
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k === "model" || k === "thinkingLevel")
      throw new ApiError(400, `${k} is set by the server and cannot be changed per user`);
    if (k !== "prefs") throw new ApiError(400, `Unknown setting: ${k}`);
  }
  const next: UserSettings = {};
  if (current.prefs) next.prefs = current.prefs;
  if ("prefs" in o) {
    if (o.prefs === null) delete next.prefs;
    else if (o.prefs && typeof o.prefs === "object" && !Array.isArray(o.prefs)) {
      // Custom themes live here; generous, but bounded.
      if (JSON.stringify(o.prefs).length > 128_000) throw new ApiError(413, "prefs too large");
      next.prefs = o.prefs as Record<string, unknown>;
    } else throw new ApiError(400, "prefs must be an object");
  }
  return next;
}
/** Per-user model overrides are disabled: everyone gets the server's model and thinking level. */
export function effectiveModel(_settings: UserSettings, _policy: SettingsPolicy) {
  return { model: undefined, thinkingLevel: undefined } as {
    model?: string;
    thinkingLevel?: string;
  };
}

// ---- in-memory (tests) ----------------------------------------------------------------------
export class MemorySettings implements SettingsStore {
  private prefs = new Map<string, UserSettings>();
  async settings(id: string) {
    return structuredClone(this.prefs.get(id) ?? {});
  }
  async saveSettings(id: string, s: UserSettings) {
    this.prefs.set(id, structuredClone(s));
    return structuredClone(s);
  }
  async deleteSettings(id: string) {
    this.prefs.delete(id);
  }
  has(id: string) {
    return this.prefs.has(id);
  }
}

// ---- Postgres ---------------------------------------------------------------------------------
export class PostgresSettings implements SettingsStore {
  private constructor(private readonly pool: Pool) {}
  /** Needs Better Auth's "user" table (createAuth runs its migrations first). */
  static async open(pool: Pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS prototype_user_settings (
      user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    return new PostgresSettings(pool);
  }
  async settings(id: string) {
    const r = await this.pool.query(
      "SELECT settings FROM prototype_user_settings WHERE user_id=$1",
      [id],
    );
    return (r.rows[0]?.settings as UserSettings) ?? {};
  }
  async saveSettings(id: string, s: UserSettings) {
    await this.pool.query(
      `INSERT INTO prototype_user_settings (user_id, settings) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
      [id, JSON.stringify(s)],
    );
    return s;
  }
  async deleteSettings(id: string) {
    await this.pool.query("DELETE FROM prototype_user_settings WHERE user_id=$1", [id]);
  }
}
