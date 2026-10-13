/**
 * AUTH_MODE=better-auth: email + password accounts and cookie sessions (https://better-auth.com).
 *
 * Better Auth owns its tables (user, session, account, verification) in the platform's Postgres;
 * tests use its in-memory adapter. The conversation owner is the Better Auth user id. Its routes
 * are mounted at /api/auth/* by api.ts; every other route (REST, WebSockets, files, previews)
 * resolves the caller from the session cookie with `user()`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { admin } from "better-auth/plugins/admin";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** Better Auth admin plugin role ("admin" or "user"). */
  role?: string;
}
/** A user as the admin Users page lists it (no secrets). */
export interface AdminUserRecord {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  /** Most recent session activity, if the user has a live session. */
  lastActiveAt: string | null;
}
/**
 * Admin operations (Better Auth admin plugin, called server-side with the admin's own request
 * headers so the plugin re-checks the role). Its /api/auth/admin/* routes are not exposed;
 * api.ts serves /api/admin/* (404 for non-admins) on top of these.
 */
export interface AdminAuth {
  listUsers(request: IncomingMessage): Promise<AdminUserRecord[]>;
  /** Signs the user out everywhere and blocks new sign-ins (ban), before their data goes. */
  lockOut(request: IncomingMessage, userId: string): Promise<void>;
  /** Sessions, accounts and the user row (Better Auth removeUser). */
  removeUser(request: IncomingMessage, userId: string): Promise<void>;
  /** New password; every session of the user is revoked. */
  setPassword(
    request: IncomingMessage,
    userId: string,
    password: string,
  ): Promise<void>;
}
export const ADMIN_ROLE = "admin";
export interface LinguiniAuth {
  /** Handles /api/auth/* (sign-up, sign-in, sign-out, get-session, ...). */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** The signed-in user for a request (session cookie), or null. */
  user(request: IncomingMessage): Promise<SessionUser | null>;
  /** Whether new accounts can be created (SIGNUP_ENABLED). */
  signupEnabled: boolean;
  /** Origins besides the request's own host that may sign in. */
  trustedOrigins: string[];
  /** Name of the session cookie (never forwarded to preview apps; see preview.ts). */
  cookiePrefix: string;
  admin: AdminAuth;
}
export interface AuthConfig {
  secret: string;
  /** Public URL of the app, e.g. https://<service>.<tailnet>.ts.net. */
  baseURL: string;
  /** Other origins allowed to sign in (e.g. the direct http://<ip>:<port> URL). */
  trustedOrigins?: string[];
  signupEnabled?: boolean;
  /** Accounts with these emails are admins (granted at startup and at sign-up). */
  adminEmails?: string[];
  /** Postgres pool; absent: in-memory (tests). */
  pool?: Pool;
}
export const COOKIE_PREFIX = "linguini";

export async function createAuth(config: AuthConfig): Promise<LinguiniAuth> {
  if (!config.secret || config.secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  const signupEnabled = config.signupEnabled ?? true;
  const options = {
    appName: "Linguini",
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: "/api/auth",
    trustedOrigins: [config.baseURL, ...(config.trustedOrigins ?? [])],
    database:
      config.pool ??
      memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !signupEnabled,
      autoSignIn: true,
      minPasswordLength: 8,
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    telemetry: { enabled: false },
    advanced: { cookiePrefix: COOKIE_PREFIX },
    plugins: [admin({ defaultRole: "user", adminRoles: [ADMIN_ROLE] })],
    databaseHooks: {
      user: {
        create: {
          before: async (user: Record<string, unknown>) => ({
            data: isBootstrapAdmin(user.email)
              ? { ...user, role: ADMIN_ROLE }
              : user,
          }),
        },
      },
    },
  };
  const adminEmails = new Set(
    (config.adminEmails ?? []).map((e) => e.trim().toLowerCase()),
  );
  const isBootstrapAdmin = (email: unknown) =>
    typeof email === "string" && adminEmails.has(email.toLowerCase());
  // Create/upgrade Better Auth's tables first (its startup check would otherwise log a mismatch).
  if (config.pool) {
    const { runMigrations } = await getMigrations(options as never);
    await runMigrations();
  }
  const auth = betterAuth(options);
  const handler = toNodeHandler(auth);
  const ctx = await auth.$context;
  // ADMIN_EMAILS: promote existing accounts (new ones get the role in the create hook above).
  for (const email of adminEmails) {
    const found = await ctx.internalAdapter.findUserByEmail(email);
    if (found && (found.user as { role?: string }).role !== ADMIN_ROLE)
      await ctx.internalAdapter.updateUser(found.user.id, { role: ADMIN_ROLE });
  }
  const headers = (request: IncomingMessage) =>
    fromNodeHeaders(request.headers);
  const adminOps: AdminAuth = {
    async listUsers(request) {
      const r = await auth.api.listUsers({
        headers: headers(request),
        query: { limit: 1000, sortBy: "createdAt", sortDirection: "asc" },
      });
      return Promise.all(
        r.users.map(async (u) => {
          const sessions = await ctx.internalAdapter.listSessions(u.id);
          const last = sessions
            .filter((s) => new Date(s.expiresAt).getTime() > Date.now())
            .map((s) => new Date(s.updatedAt).getTime())
            .reduce((a, b) => Math.max(a, b), 0);
          return {
            id: u.id,
            email: u.email,
            name: u.name,
            role: (u as { role?: string }).role ?? "user",
            createdAt: new Date(u.createdAt).toISOString(),
            lastActiveAt: last ? new Date(last).toISOString() : null,
          };
        }),
      );
    },
    async lockOut(request, userId) {
      await auth.api.banUser({
        headers: headers(request),
        body: { userId, banReason: "Account being deleted" },
      });
      await auth.api.revokeUserSessions({
        headers: headers(request),
        body: { userId },
      });
    },
    async removeUser(request, userId) {
      await auth.api.removeUser({
        headers: headers(request),
        body: { userId },
      });
    },
    async setPassword(request, userId, password) {
      await auth.api.setUserPassword({
        headers: headers(request),
        body: { userId, newPassword: password },
      });
      await auth.api.revokeUserSessions({
        headers: headers(request),
        body: { userId },
      });
    },
  };
  return {
    signupEnabled,
    trustedOrigins: options.trustedOrigins,
    cookiePrefix: COOKIE_PREFIX,
    admin: adminOps,
    handle: (request, response) => handler(request, response),
    async user(request) {
      if (!request.headers.cookie?.includes(COOKIE_PREFIX)) return null;
      const s = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      if (!s) return null;
      const role = (s.user as { role?: string | null }).role ?? "user";
      return { id: s.user.id, email: s.user.email, name: s.user.name, role };
    },
  };
}

export function authConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  pool?: Pool,
): AuthConfig {
  const secret = env.BETTER_AUTH_SECRET ?? "";
  const baseURL = env.BETTER_AUTH_URL ?? "";
  if (!baseURL)
    throw new Error(
      "Set BETTER_AUTH_URL (the app's public URL) for AUTH_MODE=better-auth",
    );
  return {
    secret,
    baseURL,
    trustedOrigins: (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    adminEmails: (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    signupEnabled: !/^(0|false|no)$/i.test(env.SIGNUP_ENABLED ?? "true"),
    ...(pool ? { pool } : {}),
  };
}
