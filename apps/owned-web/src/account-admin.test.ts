import assert from "node:assert/strict";
import { test } from "node:test";
import { accountExtensions, formatWhen } from "./account-admin.ts";
import { installUiFlags, setSettingsExtensions } from "./ui-flags.ts";

test("settings blocks: Password for everyone, Users only for admins; reach upstream flags", () => {
  assert.deepEqual(
    accountExtensions({ email: "u@x" }).map((e) => e.id),
    ["password"],
  );
  assert.deepEqual(
    accountExtensions({ email: "a@x", admin: true }).map((e) => e.id),
    ["password", "users"],
  );
  const target = {} as typeof globalThis;
  installUiFlags(target);
  setSettingsExtensions(accountExtensions({ email: "a@x", admin: true }), target);
  const flags = (
    target as unknown as { __T3_UI_FLAGS__: { settingsExtensions: Array<{ title: string }> } }
  ).__T3_UI_FLAGS__;
  assert.deepEqual(
    flags.settingsExtensions.map((e) => e.title),
    ["Password", "Users"],
  );
});
test("last active formatting", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  assert.equal(formatWhen(null, now), "—");
  assert.equal(formatWhen("2026-10-13T11:59:30Z", now), "just now");
  assert.equal(formatWhen("2026-10-13T11:30:00Z", now), "30 min ago");
  assert.equal(formatWhen("2026-10-13T07:00:00Z", now), "5 h ago");
});
test("Users page: an action's result survives the list reload; cleared by the next action or dismiss", async () => {
  const { UsersStatus } = await import("./account-admin.ts");
  const renders: string[] = [];
  const s = new UsersStatus((x) => renders.push(`${x.list.text}|${x.result?.text ?? ""}`));
  s.setList("3 users");
  s.setResult("Deleted a@x: 2 conversation(s) removed.");
  s.setList("Loading users…");
  s.setList("2 users");
  assert.equal(
    s.result?.text,
    "Deleted a@x: 2 conversation(s) removed.",
    "reload keeps the result",
  );
  assert.equal(s.list.text, "2 users");
  s.clearResult();
  assert.equal(s.result, null);
  s.setResult("boom", true);
  assert.deepEqual(s.result, { text: "boom", error: true });
  assert.equal(renders.at(-1), "2 users|boom");
});
