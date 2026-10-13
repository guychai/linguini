/**
 * Admin account management (AUTH_MODE=better-auth): the Users page's data, account deletion and
 * password resets. Roles and Better Auth's own rows go through the admin plugin (auth.ts).
 *
 * Deleting an account removes everything the user owns, in this order:
 * 1. Lock out: ban + revoke every session, so the user cannot sign in or start new work while
 *    their data is removed (running turns keep going only until step 2 tombstones them).
 * 2. Each conversation (tombstoned ones included) through the conversation deleter: tombstone
 *    (cancels queued/running work, fences the lease), then sandbox purge without a snapshot,
 *    network, egress policy file, S3 snapshots, journal + row (preview ports cascade).
 *    A conversation whose cleanup fails stays tombstoned; the deletion sweeper finishes it.
 * 3. Per-user settings, then sessions, accounts and the user row (Better Auth removeUser).
 * 4. A last pass over the user's conversations (anything created in a race).
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ADMIN_ROLE, type AdminAuth } from "./auth.ts";
import type { ConversationDeleter, DeletionReport } from "./deletion.ts";
import { ApiError, type Store } from "./store.ts";
import type { SettingsStore } from "./users.ts";

/** Sandbox states that mean compute is (or is about to be) running. */
const RUNNING = new Set(["requested", "allocating", "ready", "stopping"]);
export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  lastActiveAt: string | null;
  conversations: number;
  runningSandboxes: number;
}
export interface AccountDeletionReport {
  userId: string;
  conversations: number;
  jobs: number;
  objects: number;
  /** Conversations left tombstoned for the sweeper (cleanup step failed). */
  pending: number;
}
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AccountAdmin {
  constructor(
    private readonly admin: AdminAuth,
    private readonly store: Pick<Store, "refs">,
    private readonly deleter: Pick<ConversationDeleter, "tombstone" | "finish">,
    private readonly settings: Pick<SettingsStore, "deleteSettings">,
    private readonly log: (m: string) => void = () => {},
  ) {}
  async users(request: IncomingMessage): Promise<AdminUserView[]> {
    const [users, refs] = await Promise.all([
      this.admin.listUsers(request),
      this.store.refs(),
    ]);
    return users.map((u) => {
      const mine = refs.filter((r) => r.owner === u.id && !r.deletedAt);
      return {
        ...u,
        conversations: mine.length,
        runningSandboxes: mine.filter(
          (r) => r.handsState && RUNNING.has(r.handsState),
        ).length,
      };
    });
  }
  private async target(
    request: IncomingMessage,
    actorId: string,
    userId: string,
  ) {
    const users = await this.admin.listUsers(request);
    const user = users.find((u) => u.id === userId);
    if (!user) throw new ApiError(404, "User not found");
    return { user, users, self: userId === actorId };
  }
  async deleteUser(
    request: IncomingMessage,
    actorId: string,
    userId: string,
  ): Promise<AccountDeletionReport> {
    const { user, users, self } = await this.target(request, actorId, userId);
    if (self) throw new ApiError(400, "You cannot delete your own account");
    if (
      user.role === ADMIN_ROLE &&
      users.filter((u) => u.role === ADMIN_ROLE).length <= 1
    )
      throw new ApiError(409, "The last admin cannot be deleted");
    await this.admin.lockOut(request, userId);
    const report: AccountDeletionReport = {
      userId,
      conversations: 0,
      jobs: 0,
      objects: 0,
      pending: 0,
    };
    const purge = async () => {
      for (const r of (await this.store.refs()).filter(
        (x) => x.owner === userId,
      )) {
        let d: DeletionReport | undefined;
        try {
          await this.deleter.tombstone(userId, r.id).catch((e) => {
            if ((e as { status?: number }).status !== 404) throw e;
          });
          d = await this.deleter.finish(userId, r.id);
        } catch (e) {
          report.pending++;
          this.log(`account delete: conversation ${r.id} pending: ${why(e)}`);
          continue;
        }
        report.conversations++;
        report.jobs += d.jobs.length;
        report.objects += d.objects.length;
      }
    };
    await purge();
    await this.settings.deleteSettings(userId);
    await this.admin.removeUser(request, userId);
    await purge();
    this.log(
      `account deleted (${userId}): conversations=${report.conversations} jobs=${report.jobs} objects=${report.objects} pending=${report.pending}`,
    );
    return report;
  }
  /** Sets `password`, or a generated one (returned once). Revokes the user's sessions. */
  async resetPassword(
    request: IncomingMessage,
    actorId: string,
    userId: string,
    password?: unknown,
  ): Promise<{ password?: string }> {
    if (
      password !== undefined &&
      (typeof password !== "string" || password.length < 8)
    )
      throw new ApiError(400, "Password must be at least 8 characters");
    const { self } = await this.target(request, actorId, userId);
    if (self)
      throw new ApiError(
        400,
        "Change your own password from the Account section",
      );
    const generated =
      password === undefined
        ? randomBytes(12).toString("base64url")
        : undefined;
    await this.admin.setPassword(
      request,
      userId,
      (password as string | undefined) ?? generated!,
    );
    return generated ? { password: generated } : {};
  }
}
