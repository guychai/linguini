import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  EgressRuleError,
  registrySuffix,
  ruleCoversHost,
  validateEgressRules,
  validateOwnerEgressRules,
} from "./egress-rules.ts";

test("a stale allowWhenTainted key fails startup clearly (the flag no longer exists)", () => {
  assert.throws(
    () =>
      validateOwnerEgressRules(
        { "user-1": [{ host: "cdn.example", methods: ["GET"], allowWhenTainted: true }] },
        "EGRESS_RULES_FILE",
      ),
    (e: Error) =>
      e instanceof EgressRuleError &&
      /EGRESS_RULES_FILE \(owner user-1\)/.test(e.message) &&
      /cdn\.example/.test(e.message) &&
      /allowWhenTainted was removed/.test(e.message),
  );
});

test("package registries: GET/HEAD only; other hosts may allow any method", () => {
  for (const host of [
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
    "PyPI.ORG.",
    "*.npmjs.org",
  ])
    assert.notEqual(registrySuffix(host), null, host);
  for (const host of ["github.com", "notnpmjs.org", "pypi.org.corp.example", "*"])
    assert.equal(registrySuffix(host), null, host);
  assert.doesNotThrow(() =>
    validateEgressRules(
      [
        { host: "registry.npmjs.org", methods: ["get", "HEAD"] },
        { host: "github.com", methods: ["POST"], paths: ["/*/*/git-upload-pack"] },
        { host: "api.internal.example" },
      ],
      "test",
    ),
  );
  // Every offending rule is listed at once; no methods means all methods.
  assert.throws(
    () =>
      validateEgressRules(
        [
          { host: "registry.npmjs.org", methods: ["GET", "PUT"] },
          { host: "pypi.org" },
          { host: "*.docker.io", methods: ["POST"] },
        ],
        "EGRESS_DEFAULT_RULES_FILE",
      ),
    (e: Error) =>
      /rule 0 \(registry\.npmjs\.org\).*not PUT/.test(e.message) &&
      /rule 1 \(pypi\.org\).*\(all methods\)/.test(e.message) &&
      /rule 2 \(\*\.docker\.io\).*not POST/.test(e.message),
  );
  assert.throws(() => validateEgressRules({}, "t"), /must be an array/);
  assert.throws(() => validateOwnerEgressRules([], "t"), /owner id -> rules/);
});

test("denied hosts (EGRESS_DENY_HOSTS) may never be admitted by a rule", () => {
  assert.equal(ruleCoversHost("trino.corp.example", "trino.corp.example"), true);
  assert.equal(ruleCoversHost("*.corp.example", "trino.corp.example"), true);
  assert.equal(ruleCoversHost("a.warehouse.example", "*.warehouse.example"), true);
  assert.equal(ruleCoversHost("warehouse.example", "*.warehouse.example"), true);
  assert.equal(ruleCoversHost("cdn.example", "*.warehouse.example"), false);
  assert.throws(
    () => validateEgressRules([{ host: "*.corp.example" }], "t", ["trino.corp.example"]),
    /admits trino\.corp\.example/,
  );
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
