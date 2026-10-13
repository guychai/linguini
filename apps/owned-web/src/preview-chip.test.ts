import { test } from "node:test";
import assert from "node:assert/strict";
import { previewVersion } from "./preview-chip.ts";

test("preview chip refetches only when a share/unshare event arrives", () => {
  const c = (events: Array<[number, string]>) =>
    ({ id: "t1", events: events.map(([seq, type]) => ({ seq, type, data: {} })) }) as never;
  assert.equal(previewVersion(c([[1, "message.user"]])), "t1:0");
  assert.equal(
    previewVersion(
      c([
        [1, "preview.shared"],
        [2, "message.user"],
      ]),
    ),
    "t1:1",
  );
  assert.equal(
    previewVersion(
      c([
        [1, "preview.shared"],
        [5, "preview.unshared"],
      ]),
    ),
    "t1:5",
  );
});
