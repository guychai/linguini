import type { EgressGitHub } from "./hands.ts";

/**
 * Which owners' sandboxes may use the node's GitHub App (repo-scoped read tokens minted by the
 * egress proxy, infra/sandbox-kit/egress/addon/github_app.py).
 *
 * `GITHUB_APP_OWNERS`: comma-separated owner IDs (the Better Auth user id; the same keys as
 * EGRESS_RULES_FILE). Unset or empty: nobody, so a new account never reads the App owner's private
 * repositories by default. There is deliberately no wildcard: the App acts as itself, not as the
 * Linguini user, so every owner listed can read every repository the App is installed on.
 */
export function githubAppAccessFromEnv(
  env: Record<string, string | undefined>,
): (owner: string) => EgressGitHub | undefined {
  const owners = new Set(
    (env.GITHUB_APP_OWNERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const o of owners)
    if (o === "*" || o.length > 100 || /\s/.test(o))
      throw new Error(`GITHUB_APP_OWNERS: invalid owner ${JSON.stringify(o)} (list owner IDs)`);
  return (owner) => (owners.has(owner) ? { app: true } : undefined);
}
