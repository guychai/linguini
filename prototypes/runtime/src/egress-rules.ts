// Startup validation of egress rules (trusted server config: EGRESS_DEFAULT_RULES_FILE and the
// per-owner EGRESS_RULES_FILE). Taintless model: no rule depends on what a conversation read.
//
// - Package registries take GET/HEAD only: a rule granting other methods there (publishing from a
//   sandbox) refuses startup. The proxy enforces the same (sandbox_egress.py REGISTRY_SUFFIXES)
//   for rules that reach a policy any other way.
// - `allowWhenTainted` no longer exists: a rule still carrying it refuses startup, so a stale
//   rules file is fixed rather than silently reinterpreted.
// - Denied hosts (EGRESS_DENY_HOSTS: the data warehouse, internal services) may never be admitted.
import type { EgressRule } from "./hands.ts";

/** Package registries (and all their subdomains): GET/HEAD only. */
export const REGISTRY_SUFFIXES: readonly string[] = Object.freeze([
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
export const REGISTRY_METHODS: readonly string[] = Object.freeze(["GET", "HEAD"]);

const norm = (host: string) => host.trim().toLowerCase().replace(/\.+$/, "");

/** The registry suffix this host falls under (wildcards included), or null. */
export function registrySuffix(host: string): string | null {
  const h = norm(host).replace(/^\*\./, "");
  if (!h) return null;
  return REGISTRY_SUFFIXES.find((s) => h === s || h.endsWith(`.${s}`)) ?? null;
}

export class EgressRuleError extends Error {}

/**
 * Whether an allowlist rule host admits `denied` (exact, or a wildcard covering it). `denied` may
 * itself be a wildcard (`*.warehouse.corp`): then any rule inside that zone, or covering it, hits.
 */
export function ruleCoversHost(ruleHost: string, denied: string): boolean {
  const r = norm(ruleHost),
    d = norm(denied);
  if (!r || !d) return false;
  const zone = (h: string) => (h.startsWith("*.") ? h.slice(2) : undefined);
  const rz = zone(r),
    dz = zone(d);
  if (!rz && !dz) return r === d;
  if (rz && !dz) return d.endsWith(`.${rz}`);
  if (!rz && dz) return r === dz || r.endsWith(`.${dz}`);
  return rz === dz || rz!.endsWith(`.${dz}`) || dz!.endsWith(`.${rz}`);
}

/**
 * Throws EgressRuleError naming every offending rule; `source` says where the rules came from.
 * `deniedHosts` (EGRESS_DENY_HOSTS) may never be reachable from a sandbox: any rule that admits
 * one of them refuses startup.
 */
export function validateEgressRules(
  rules: unknown,
  source: string,
  deniedHosts: readonly string[] = [],
): EgressRule[] {
  if (!Array.isArray(rules)) throw new EgressRuleError(`${source}: egress rules must be an array`);
  const problems: string[] = [];
  rules.forEach((rule, i) => {
    // Only the safety rules are checked here; other shape errors stay the proxy's to ignore.
    if (!rule || typeof rule !== "object") return;
    const r = rule as EgressRule & { allowWhenTainted?: unknown };
    const host = typeof r.host === "string" ? r.host : "";
    if ("allowWhenTainted" in r)
      problems.push(
        `rule ${i} (${host}): allowWhenTainted was removed (no sensitive-thread state); drop the key`,
      );
    const denied = host ? deniedHosts.find((d) => ruleCoversHost(host, d)) : undefined;
    if (denied) {
      problems.push(`rule ${i} (${host}): admits ${denied}, which sandboxes may never reach`);
      return;
    }
    const registry = host ? registrySuffix(host) : null;
    if (registry) {
      const methods = Array.isArray(r.methods) ? r.methods.map((m) => String(m).toUpperCase()) : [];
      const extra = methods.length
        ? methods.filter((m) => !REGISTRY_METHODS.includes(m))
        : ["(all methods)"];
      if (extra.length)
        problems.push(
          `rule ${i} (${host}): package registry (${registry}) rules may only allow GET/HEAD, not ${extra.join(", ")}`,
        );
    }
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
  deniedHosts: readonly string[] = [],
): Record<string, EgressRule[]> {
  if (!byOwner || typeof byOwner !== "object" || Array.isArray(byOwner))
    throw new EgressRuleError(`${source}: must be an object of owner id -> rules`);
  const out: Record<string, EgressRule[]> = {};
  for (const [owner, rules] of Object.entries(byOwner))
    out[owner] = validateEgressRules(rules, `${source} (owner ${owner})`, deniedHosts);
  return out;
}
