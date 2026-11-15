import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  EgressRuleError,
  taintUnsafeReason,
  validateEgressRules,
  validateOwnerEgressRules,
} from "./egress-rules.ts";

test("A0.5 allowWhenTainted on api.github.com in a per-owner rule fails startup clearly", () => {
  assert.throws(
    () =>
      validateOwnerEgressRules(
        { "user-1": [{ host: "api.github.com", methods: ["GET"], allowWhenTainted: true }] },
        "EGRESS_RULES_FILE",
      ),
    (e: Error) =>
      e instanceof EgressRuleError &&
      /EGRESS_RULES_FILE \(owner user-1\)/.test(e.message) &&
      /api\.github\.com/.test(e.message) &&
      /allowWhenTainted/.test(e.message),
  );
});

test("P0.4 code hosts, registries and wildcards cannot be taint-exempt; other hosts can", () => {
  for (const host of [
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "ghcr.io",
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
    "GitHub.COM.",
    "*.example.com",
    "*",
  ])
    assert.notEqual(taintUnsafeReason(host), null, host);
  for (const host of ["cdn.internal.example", "notgithub.com", "github.com.corp.example"])
    assert.equal(taintUnsafeReason(host), null, host);
  // Without the flag (or with false) any host is fine; the flag must be a real boolean.
  assert.doesNotThrow(() =>
    validateEgressRules(
      [
        { host: "github.com", methods: ["GET"] },
        { host: "*.example.com", allowWhenTainted: false },
        { host: "cdn.internal.example", allowWhenTainted: true },
      ],
      "test",
    ),
  );
  assert.throws(
    () => validateEgressRules([{ host: "cdn.internal.example", allowWhenTainted: "yes" }], "t"),
    /must be a boolean/,
  );
  // Every offending rule is listed at once.
  assert.throws(
    () =>
      validateEgressRules(
        [
          { host: "pypi.org", allowWhenTainted: true },
          { host: "*.cdn.example", allowWhenTainted: true },
        ],
        "EGRESS_DEFAULT_RULES_FILE",
      ),
    (e: Error) =>
      /rule 0 \(pypi\.org\)/.test(e.message) && /rule 1 \(\*\.cdn\.example\)/.test(e.message),
  );
  assert.throws(() => validateEgressRules({}, "t"), /must be an array/);
  assert.throws(() => validateOwnerEgressRules([], "t"), /owner id -> rules/);
});

test("the shipped default rules pass validation", async () => {
  const rules = JSON.parse(
    await readFile(
      new URL("../../../infra/hosting/egress-default-rules.json", import.meta.url),
      "utf8",
    ),
  );
  assert.doesNotThrow(() => validateEgressRules(rules, "egress-default-rules.json"));
});
