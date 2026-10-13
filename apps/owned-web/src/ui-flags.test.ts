// The owned shell's UI flags reach upstream's flag module when installed before startup.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installUiFlags, OWNED_UI_FLAGS } from "./ui-flags.ts";

test("installUiFlags is read by apps/web uiFlags (hide projects and Git)", async () => {
  installUiFlags();
  const { uiFlags } = await import("../../web/src/uiFlags.ts");
  assert.deepEqual(uiFlags, OWNED_UI_FLAGS);
  assert.equal(uiFlags.hideProjects, true);
  assert.equal(uiFlags.hideGit, true);
  assert.equal(uiFlags.hideThreadDetails, true);
  assert.equal(uiFlags.hideUsage, true);
  assert.equal(uiFlags.hideEditorPicker, true);
  const { isRightPanelSurfaceHidden } = await import("../../web/src/uiFlags.ts");
  for (const k of ["preview", "diff", "pull-request", "pull-requests", "device"])
    assert.equal(isRightPanelSurfaceHidden(k), true, k);
  for (const k of ["terminal", "files"]) assert.equal(isRightPanelSurfaceHidden(k), false, k);
});

test("the signed-in user reaches upstream flags when set before startup", async () => {
  const { setSignedInUser } = await import("./ui-flags.ts");
  const target = {} as typeof globalThis;
  installUiFlags(target);
  let signedOut = 0;
  setSignedInUser({ email: "ada@example.com", name: "Ada Lovelace" }, () => signedOut++, target);
  const flags = (target as unknown as { __T3_UI_FLAGS__: Record<string, unknown> }).__T3_UI_FLAGS__;
  assert.deepEqual(flags.signedInUser, { name: "Ada Lovelace", login: "ada@example.com" });
  assert.equal("signedInUser" in OWNED_UI_FLAGS, false, "the shared defaults are not mutated");
  (flags.signOut as () => void)();
  assert.equal(signedOut, 1);
  setSignedInUser({ email: "a@b", name: null }, undefined, target);
  assert.deepEqual(flags.signedInUser, { name: "a@b", login: "a@b" });
});
