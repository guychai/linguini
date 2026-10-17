// Removes a run's throwaway account: its conversations through the API (cascades previews and
// renders), then the user rows through E2E_CLEANUP_CMD, a command that runs SQL from stdin against
// the deployment's database, e.g.
//   E2E_CLEANUP_CMD='ssh -i ~/.ssh/key me@node sudo -n -u agentplat psql -d agentplat -v ON_ERROR_STOP=1'
// Only rows of this run's own e2e-<runId>-*@test.linguini addresses are touched.
import { chromium, type LaunchOptions } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export function cleanupSql(runId: string) {
  if (!/^[a-z0-9]+$/.test(runId)) throw new Error(`bad run id ${runId}`);
  const users = `select id from "user" where email like 'e2e-${runId}-%@test.linguini'`;
  return `begin;
delete from prototype_conversations where owner in (${users});
delete from prototype_user_settings where user_id in (${users});
delete from prototype_html_renders where owner in (${users});
delete from session where "userId" in (${users});
delete from account where "userId" in (${users});
delete from "user" where email like 'e2e-${runId}-%@test.linguini';
commit;
`;
}

export async function deleteConversations(baseURL: string, launch: LaunchOptions, ignoreHTTPSErrors: boolean) {
  if (!existsSync(".run/state.json")) return [];
  const browser = await chromium.launch(launch);
  try {
    const ctx = await browser.newContext({ baseURL, ignoreHTTPSErrors, storageState: ".run/state.json" });
    const p = await ctx.newPage();
    await p.goto("/");
    return await p.evaluate(async () => {
      const h = { "x-linguini-client": "1" };
      const r = await fetch("/api/conversations", { headers: h });
      if (!r.ok) return [`list ${r.status}`];
      const out: number[] = [];
      for (const c of await r.json()) out.push((await fetch(`/api/conversations/${c.id}`, { method: "DELETE", headers: h })).status);
      return out;
    });
  } finally {
    await browser.close();
  }
}

export function deleteUsers(runId: string) {
  const cmd = process.env.E2E_CLEANUP_CMD;
  const sql = cleanupSql(runId);
  if (!cmd) {
    console.warn(`E2E_CLEANUP_CMD is not set: remove the throwaway user by running this SQL on the node:\n${sql}`);
    return false;
  }
  const r = spawnSync("sh", ["-c", cmd], { input: sql, encoding: "utf8" });
  if (r.status !== 0) {
    console.warn(`user cleanup failed (${r.status}): ${r.stderr}\nSQL to run by hand:\n${sql}`);
    return false;
  }
  console.log(`removed e2e-${runId}-* users`);
  return true;
}

// Standalone: `npx tsx cleanup.ts <runId>` or `node --experimental-strip-types cleanup.ts <runId>`
// (users only; their conversations go with them).
if (import.meta.url === `file://${process.argv[1]}`) {
  const runId = process.argv[2];
  if (!runId) throw new Error("usage: cleanup.ts <runId>");
  process.exit(deleteUsers(runId) ? 0 : 1);
}
