import { test } from "node:test";
import assert from "node:assert/strict";
import { projection } from "./projection.ts";

// Upstream's timeline shows an item's status as a chip under the message unless it is "completed".
// Sent messages are completed at once (as upstream's orchestrator records them); a streaming reply
// stays "running" but carries its run's id, which upstream uses to hold back the reply's info row
// until the run settles.
const conv = (status: string) =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    title: "t",
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
    tainted: false,
    sandboxAllocated: false,
    jobs: [{ id: "j1", text: "hi", status, requestedAt: "2026-10-12T11:00:00.000Z" }],
    events: [
      {
        seq: 1,
        type: "assistant.delta",
        timestamp: "2026-10-12T11:00:02.000Z",
        data: { jobId: "j1", text: "par" },
      },
    ],
  }) as never;
type P = {
  runs: Array<{ id: string; status: string }>;
  turnItems: Array<{ type: string; status: string; runId: string }>;
  messages: Array<{ role: string; runId: string }>;
};

for (const status of ["running", "done", "cancelled", "rejected"]) {
  test(`sent message is completed while the turn is ${status}`, () => {
    const p = projection(conv(status)) as unknown as P;
    assert.equal(p.turnItems.find((i) => i.type === "user_message")!.status, "completed");
  });
}

test("a streaming reply is linked to its running run", () => {
  const p = projection(conv("running")) as unknown as P;
  const run = p.runs.find((r) => r.status === "running")!;
  const reply = p.turnItems.find((i) => i.type === "assistant_message")!;
  assert.equal(reply.status, "running");
  assert.equal(reply.runId, run.id);
  assert.equal(p.messages.find((m) => m.role === "assistant")!.runId, run.id);
});

test("a finished reply is completed", () => {
  const p = projection(conv("done")) as unknown as P;
  assert.equal(p.turnItems.find((i) => i.type === "assistant_message")!.status, "completed");
});
