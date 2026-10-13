import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THEME_KEYS,
  installAccountStorage,
  scopePrefix,
  signOutAccountStorage,
} from "./account-storage.ts";

class MemStorage {
  m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const win = (base: MemStorage) => ({ localStorage: base }) as unknown as typeof globalThis;

test("content keys are per account; theme comes from (and is saved to) the account", async () => {
  const base = new MemStorage();
  base.setItem("t3code:prompt-stash:v2", "old unscoped stash"); // from before scoping
  base.setItem("t3code:theme", "iris"); // device mirror left by someone else
  const saved: unknown[] = [];
  const store = { prefs: { theme: { "t3code:theme": "grove" } } as Record<string, unknown> };
  const w = win(base);
  await installAccountStorage("A", {
    get: async () => store,
    put: async (s) => void saved.push(s),
  }, w);
  const ls = w.localStorage;
  assert.equal(base.getItem("t3code:prompt-stash:v2"), null, "stale unscoped content dropped");
  assert.equal(ls.getItem("t3code:theme"), "grove", "account theme applied");
  ls.setItem("t3code:composer-drafts:v1", "A's draft");
  ls.setItem("t3code:prompt-stash:v2", "A's stash");
  assert.equal(base.getItem(`${scopePrefix("A")}t3code:composer-drafts:v1`), "A's draft");
  assert.equal(base.getItem("t3code:composer-drafts:v1"), null);
  assert.equal(ls.length, 2);
  ls.setItem("t3code:theme-appearance-mode", "dark");
  await signOutAccountStorage(); // flushes the theme, wipes A's local data
  assert.deepEqual(saved.at(-1), {
    prefs: { theme: { "t3code:theme": "grove", "t3code:theme-appearance-mode": "dark" } },
  });
  assert.ok(![...base.m.keys()].some((k) => k.startsWith(scopePrefix("A"))), "A's data wiped");
  for (const k of THEME_KEYS) assert.equal(base.getItem(k), null, "theme mirror cleared");
  // B on the same browser: defaults, none of A's content.
  const wb = win(base);
  await installAccountStorage("B", { get: async () => ({}), put: async () => {} }, wb);
  assert.equal(wb.localStorage.getItem("t3code:prompt-stash:v2"), null);
  assert.equal(wb.localStorage.getItem("t3code:theme"), null);
});
