import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sandboxSystemPrompt, describeEgress } from "./sandbox-prompt.ts";
import { TOOL_DESCRIPTIONS } from "./pi-tools.ts";

test("system prompt states the sandbox facts and lists the allowed hosts from the rules", () => {
  const rules = JSON.parse(
    readFileSync(
      new URL("../../../infra/hosting/egress-default-rules.json", import.meta.url),
      "utf8",
    ),
  );
  const p = sandboxSystemPrompt(rules);
  for (const fact of [
    "Kata Containers microVM",
    "/workspace",
    "bash",
    "mise use node@22",
    "own daemon, not the user's host",
    "15 minutes",
    "cannot see it",
    "docker exec",
    "2 GiB",
  ])
    assert.ok(p.includes(fact), fact);
  assert.ok(
    p.includes("github.com: GET/HEAD; POST /*/*/git-upload-pack, /*/*.git/git-upload-pack"),
  );
  assert.ok(p.includes("registry.npmjs.org: GET/HEAD"));
  // Git: what works (public clone, private via the App), what does not (push, PRs), no tokens.
  for (const fact of [
    "Clone, fetch, pull and ls-remote work for public repositories",
    "Linguini GitHub App",
    "git-push-not-enabled",
    "never ask the user for a personal access token",
    "rewritten to HTTPS",
  ])
    assert.ok(p.includes(fact), fact);
  assert.ok(!/git worktrees/.test(p));
  assert.ok(!/host-control|\/var\/lib\/agentplat/.test(p));
  assert.match(sandboxSystemPrompt([]), /no outbound network access/);
  assert.equal(describeEgress([{ host: "a.example", methods: ["GET"] }]), "  - a.example: GET");
});
test("every tool has a specific description", () => {
  for (const [name, d] of Object.entries(TOOL_DESCRIPTIONS)) assert.ok(d.length > 40, name);
  assert.match(TOOL_DESCRIPTIONS.bash, /max 600/);
});
