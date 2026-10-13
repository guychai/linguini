import { test } from "node:test";
import assert from "node:assert/strict";
import { jobTiming, projection } from "./projection.ts";

const ev = (seq: number, type: string, timestamp: string, data: Record<string, unknown> = {}) => ({
  seq,
  type,
  timestamp,
  data: { jobId: "j1", ...data },
});
const conv = (job: Record<string, unknown>, events: ReturnType<typeof ev>[]) =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    title: "t",
    createdAt: "2026-10-12T10:00:00.000Z",
    updatedAt: "2026-10-12T12:00:00.000Z",
    tainted: false,
    sandboxAllocated: false,
    jobs: [{ id: "j1", text: "hi", ...job }],
    events,
  }) as never;

test("runs and messages carry the persisted turn times", () => {
  const c = conv(
    {
      status: "done",
      requestedAt: "2026-10-12T11:00:00.000Z",
      startedAt: "2026-10-12T11:00:01.000Z",
      completedAt: "2026-10-12T11:00:43.000Z",
    },
    [ev(1, "assistant.delta", "2026-10-12T11:00:40.000Z", { text: "ok" })],
  );
  const p = projection(c) as unknown as {
    runs: Array<{ startedAt: unknown; completedAt: unknown }>;
    messages: Array<{ createdAt: unknown; updatedAt: unknown }>;
  };
  const ms = (v: unknown) =>
    typeof v === "object" && v !== null && "epochMilliseconds" in v
      ? Number((v as { epochMilliseconds: number }).epochMilliseconds)
      : typeof v === "object" && v !== null && "epochMillis" in v
        ? Number((v as { epochMillis: number }).epochMillis)
        : Date.parse(String(v));
  assert.equal(ms(p.runs[0]!.completedAt) - ms(p.runs[0]!.startedAt), 42_000);
  assert.equal(ms(p.messages[1]!.updatedAt) - ms(p.messages[1]!.createdAt), 42_000);
  assert.equal(ms(p.messages[0]!.createdAt), ms("2026-10-12T11:00:00.000Z"));
});

test("older turns fall back to journal timestamps, else no duration", () => {
  const fromJournal = jobTiming(
    conv({ status: "done" }, [
      ev(1, "message.user", "2026-10-12T11:00:00.000Z"),
      ev(2, "run.started", "2026-10-12T11:00:02.000Z"),
      ev(3, "assistant.delta", "2026-10-12T11:00:09.000Z"),
      ev(4, "run.completed", "2026-10-12T11:00:10.000Z"),
    ]),
    { id: "j1", text: "hi", status: "done" },
  );
  assert.deepEqual(
    [fromJournal.startedAt, fromJournal.completedAt],
    ["2026-10-12T11:00:02.000Z", "2026-10-12T11:00:10.000Z"],
  );
  const nothing = jobTiming(conv({ status: "done" }, []), { id: "j1", text: "hi", status: "done" });
  assert.equal(nothing.startedAt, null, "no invented start");
  const running = jobTiming(
    conv({ status: "running", startedAt: "2026-10-12T11:00:00.000Z" }, []),
    { id: "j1", text: "hi", status: "running", startedAt: "2026-10-12T11:00:00.000Z" },
  );
  assert.equal(running.completedAt, null, "in progress: open-ended, so the UI counts live");
});
