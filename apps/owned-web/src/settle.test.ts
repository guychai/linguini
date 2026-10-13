// T3 settle/unsettle commands map to the owned metadata endpoint; the projection carries the state.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as C from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const calls: { url: string; body: unknown }[] = [];
const conversation = {
  id: "one",
  title: "t",
  tainted: false,
  jobs: [],
  events: [],
  metadata: {
    settledOverride: "settled",
    settledAt: "2026-10-12T19:00:00.000Z",
    unsettledAt: null,
  },
};
// Another conversation with a long history: per-thread and shell sequences differ.
const other = {
  id: "two",
  title: "u",
  tainted: false,
  jobs: [],
  events: [{ seq: 500, type: "metadata.updated", data: {} }],
};
(globalThis as any).sessionStorage = { getItem: () => "tok" };
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const u = String(url);
  if (u.endsWith("/metadata")) {
    // The write appends an event to this conversation (as the backend does).
    (conversation.events as any[]).push({
      seq: conversation.events.length + 1,
      type: "metadata.updated",
      data: {},
    });
    return new Response(JSON.stringify({ metadata: {} }));
  }
  const body = u.startsWith("/api/conversations?") ? [conversation, other] : conversation;
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
const { invoke } = await import("./t3-adapter.ts");
const { projection, serverConfig, shell } = await import("./projection.ts");

test("lifecycle commands acknowledge with the shell sequence that includes the write", async () => {
  // The client keeps its optimistic settle until a *shell* snapshot reaches the acknowledged
  // sequence. A per-thread sequence (small) would be "reached" by the stale pre-write shell,
  // dropping the optimistic state and making the row reappear until the next refresh.
  const before = shell([conversation, other] as any).snapshotSequence;
  const ack = (await invoke("orchestration.dispatchCommand", {
    type: "thread.settle",
    commandId: "seq-1",
    threadId: "one",
  })) as { sequence: number };
  assert.ok(ack.sequence > before, `ack ${ack.sequence} must exceed pre-write shell ${before}`);
  assert.equal(ack.sequence, shell([conversation, other] as any).snapshotSequence);
});

test("thread.settle / thread.unsettle dispatch to the owned settle action", async () => {
  for (const [type, settle] of [
    ["thread.settle", "settled"],
    ["thread.unsettle", "active"],
  ] as const) {
    calls.length = 0;
    await invoke("orchestration.dispatchCommand", {
      type,
      commandId: `c-${type}`,
      threadId: "one",
      ...(type === "thread.unsettle" ? { reason: "user" } : {}),
    });
    const meta = calls.find((c) => c.url === "/api/conversations/one/metadata");
    assert.deepEqual(meta?.body, { commandId: `c-${type}`, settle });
  }
});

test("projection and capabilities expose settlement in the upstream contract shape", () => {
  const p = projection(conversation as any);
  assert.equal(p.thread.settledOverride, "settled");
  assert.match(String(p.thread.settledAt), /2026-10-12T19:00:00.000Z/);
  assert.ok(Schema.is(C.OrchestrationV2ThreadProjection)(p));
  assert.equal(serverConfig().environment.capabilities.threadSettlement, true);
  // Auto-settlement and snooze are not implemented, so the UI must not offer them.
  assert.equal(serverConfig().environment.capabilities.threadAutoSettlement, undefined);
  assert.equal(serverConfig().environment.capabilities.threadSnooze, undefined);
});

test("file metadata RPC answers unknown for every path (no host filesystem)", async () => {
  assert.deepEqual(await invoke("filesystem.getMetadata", { paths: ["/a", "~/b"] }), {
    entries: [null, null],
  });
});
