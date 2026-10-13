import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceProblem } from "./workspace-notice.ts";

const conv = (events: Array<[string, Record<string, unknown>]>) =>
  ({ id: "c", events: events.map(([type, data], i) => ({ seq: i + 1, type, data })) }) as never;

test("workspace notice: only the latest persistence event decides", () => {
  assert.equal(workspaceProblem(conv([])), null);
  assert.match(
    workspaceProblem(conv([["workspace.restore_failed", {}]]))!.text,
    /without the files/,
  );
  assert.equal(
    workspaceProblem(
      conv([
        ["workspace.restore_failed", {}],
        ["workspace.restored", {}],
      ]),
    ),
    null,
  );
  assert.equal(workspaceProblem(conv([["workspace.save_failed", { stoppedAnyway: false }]])), null);
  assert.match(
    workspaceProblem(conv([["workspace.save_failed", { stoppedAnyway: true }]]))!.text,
    /could not be saved/,
  );
});
