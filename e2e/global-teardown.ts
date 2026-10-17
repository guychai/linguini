import type { FullConfig } from "@playwright/test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { deleteConversations, deleteUsers } from "./cleanup.ts";

export default async function teardown(config: FullConfig) {
  if (!existsSync(".run/account.json")) return;
  const { runId } = JSON.parse(readFileSync(".run/account.json", "utf8"));
  const use = config.projects[0]!.use;
  try {
    console.log("deleted conversations:", await deleteConversations(use.baseURL!, use.launchOptions ?? {}, !!use.ignoreHTTPSErrors));
  } catch (e) {
    console.warn("conversation cleanup failed (the user cleanup below cascades):", (e as Error).message);
  }
  if (deleteUsers(runId)) rmSync(".run", { recursive: true, force: true });
}
