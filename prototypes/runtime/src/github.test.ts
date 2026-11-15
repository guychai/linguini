import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubAppAccessFromEnv } from "./github.ts";
import { FileEgressPolicyWriter } from "./hands.ts";

test("GitHub App access is per owner and off by default", () => {
  assert.equal(githubAppAccessFromEnv({})("owner-1"), undefined);
  assert.equal(githubAppAccessFromEnv({ GITHUB_APP_OWNERS: "" })("owner-1"), undefined);
  const access = githubAppAccessFromEnv({ GITHUB_APP_OWNERS: " owner-1 , owner-2," });
  assert.deepEqual(access("owner-1"), { app: true });
  assert.deepEqual(access("owner-2"), { app: true });
  assert.equal(access("owner-3"), undefined);
  assert.equal(access(""), undefined);
  assert.throws(() => githubAppAccessFromEnv({ GITHUB_APP_OWNERS: "*" }), /invalid owner/);
});

test("the policy file carries github only when set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "egress-gh-"));
  const writer = new FileEgressPolicyWriter(dir);
  const base = { version: 1 as const, workspaceId: "ws", tainted: false, rules: [] };
  await writer.apply({ ...base, conversationKey: "aaaaaaaaaaaaaaaa", github: { app: true } });
  await writer.apply({ ...base, conversationKey: "bbbbbbbbbbbbbbbb", github: undefined });
  const a = JSON.parse(await readFile(join(dir, "aaaaaaaaaaaaaaaa.json"), "utf8"));
  const b = JSON.parse(await readFile(join(dir, "bbbbbbbbbbbbbbbb.json"), "utf8"));
  assert.deepEqual(a.github, { app: true });
  assert.equal("github" in b, false);
});
