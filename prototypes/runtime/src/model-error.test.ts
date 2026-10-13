import { test } from "node:test";
import assert from "node:assert/strict";
import { PiHarness } from "./harness.ts";

function fakeSession(messages: Array<Record<string, unknown>>) {
  let listener: (e: unknown) => void = () => {};
  return {
    subscribe(f: (e: unknown) => void) {
      listener = f;
      return () => {};
    },
    async prompt() {
      for (const m of messages) {
        listener({ type: "message_start", message: m });
        if (typeof m.text === "string")
          listener({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: m.text },
          });
        listener({ type: "message_end", message: m });
      }
    },
    async abort() {},
    async steer() {},
    dispose() {},
  };
}
async function run(messages: Array<Record<string, unknown>>) {
  const events: Array<[string, Record<string, unknown>]> = [];
  const h = new PiHarness(fakeSession(messages) as never);
  await h.run("hi", "", async (t, d) => void events.push([t, d]), new AbortController().signal);
  return events;
}

test("a model refusal/error becomes a visible error, not a blank reply", async () => {
  const events = await run([
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "This request triggered restrictions … Usage Policy.",
      content: [],
    },
  ]);
  const text = events
    .filter(([t]) => t === "assistant.delta")
    .map(([, d]) => d.text)
    .join("");
  assert.match(text, /Model request failed: This request triggered restrictions/);
  assert.ok(events.some(([t, d]) => t === "assistant.error" && d.stopReason === "error"));
});

test("a refusal stop reason without a message still says something", async () => {
  const events = await run([{ role: "assistant", stopReason: "refusal", content: [] }]);
  assert.ok(
    events.some(([t, d]) => t === "assistant.delta" && /stop reason: refusal/.test(String(d.text))),
  );
});

test("normal replies are unchanged", async () => {
  const events = await run([{ role: "assistant", stopReason: "stop", text: "hello" }]);
  assert.deepEqual(events, [["assistant.delta", { text: "hello" }]]);
});
