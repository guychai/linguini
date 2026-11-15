// Startup validation of egress rules (trusted server config: EGRESS_DEFAULT_RULES_FILE and the
// per-owner EGRESS_RULES_FILE). The proxy enforces the same rule (sandbox_egress.py
// TAINT_UNSAFE_SUFFIXES), because node config can set rules too.
//
// `allowWhenTainted` keeps a host reachable after the conversation has read production data. That
// is only safe for hosts whose request logs nobody outside us can read. A public code host or
// package registry is not one of them: even with `methods: ["GET"]` and `paths` globs, data can
// ride in the path or query (`api.github.com/repos/<data>/…`, `registry.npmjs.org/<data>`), and
// the registry, or whoever owns the named package or repository, sees it. Wildcard hosts are
// refused too: `*.example.com` admits names nobody reviewed.
import type { EgressRule } from "./hands.ts";

/** Hosts (and all their subdomains) that may never be reachable after taint. */
export const TAINT_UNSAFE_SUFFIXES: readonly string[] = Object.freeze([
  // GitHub: api, codeload, raw/objects content, gists, release assets.
  "github.com",
  "githubusercontent.com",
  "ghcr.io",
  // npm (and yarn's mirror of it).
  "npmjs.org",
  "npmjs.com",
  "yarnpkg.com",
  // PyPI and its file host.
  "pypi.org",
  "pythonhosted.org",
  // Docker Hub (registry, auth, CDN).
  "docker.io",
  "docker.com",
]);

const norm = (host: string) => host.trim().toLowerCase().replace(/\.+$/, "");

/** Why `allowWhenTainted` is refused on this rule host, or null when it is acceptable. */
export function taintUnsafeReason(host: string): string | null {
  const h = norm(host);
  if (!h) return "empty host";
  if (h.includes("*")) return "wildcard host";
  const hit = TAINT_UNSAFE_SUFFIXES.find((s) => h === s || h.endsWith(`.${s}`));
  return hit ? `public code host or package registry (${hit})` : null;
}

export class EgressRuleError extends Error {}

/** Throws EgressRuleError naming every offending rule; `source` says where the rules came from. */
export function validateEgressRules(rules: unknown, source: string): EgressRule[] {
  if (!Array.isArray(rules)) throw new EgressRuleError(`${source}: egress rules must be an array`);
  const problems: string[] = [];
  rules.forEach((rule, i) => {
    // Only the taint exemption is checked here; other shape errors stay the proxy's to ignore.
    if (!rule || typeof rule !== "object") return;
    const r = rule as EgressRule;
    if (r.allowWhenTainted === undefined || r.allowWhenTainted === false) return;
    if (typeof r.host !== "string") {
      problems.push(`rule ${i}: allowWhenTainted needs a string "host"`);
      return;
    }
    if (r.allowWhenTainted !== true) {
      problems.push(`rule ${i} (${r.host}): allowWhenTainted must be a boolean`);
      return;
    }
    const why = taintUnsafeReason(r.host);
    if (why) problems.push(`rule ${i} (${r.host}): allowWhenTainted is not allowed on a ${why}`);
  });
  if (problems.length)
    throw new EgressRuleError(
      `${source}: refusing to start, unsafe egress rules:\n  ${problems.join("\n  ")}`,
    );
  return rules as EgressRule[];
}

/** The per-owner rules file: `{ownerId: EgressRule[]}`. */
export function validateOwnerEgressRules(
  byOwner: unknown,
  source: string,
): Record<string, EgressRule[]> {
  if (!byOwner || typeof byOwner !== "object" || Array.isArray(byOwner))
    throw new EgressRuleError(`${source}: must be an object of owner id -> rules`);
  const out: Record<string, EgressRule[]> = {};
  for (const [owner, rules] of Object.entries(byOwner))
    out[owner] = validateEgressRules(rules, `${source} (owner ${owner})`);
  return out;
}
