import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, initial, read, stampJobTimes } from "./store.ts";

test("store stamps real turn times on status transitions only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "timing-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await store.create(initial("c1", "o"));
  await store.mutate(
    "o",
    "c1",
    (c) => void c.jobs.push({ id: "j1", text: "hi", status: "queued" }),
  );
  let j = (await read(store, "o", "c1")).jobs[0]!;
  assert.ok(j.requestedAt && !j.startedAt && !j.completedAt);
  await new Promise((r) => setTimeout(r, 30));
  await store.mutate("o", "c1", (c) => void (c.jobs[0]!.status = "running"));
  await new Promise((r) => setTimeout(r, 120));
  await store.mutate("o", "c1", (c) => void (c.title = "unrelated write"));
  j = (await read(store, "o", "c1")).jobs[0]!;
  assert.ok(j.startedAt && !j.completedAt, "unrelated writes do not stamp");
  await store.mutate("o", "c1", (c) => void (c.jobs[0]!.status = "done"));
  j = (await read(store, "o", "c1")).jobs[0]!;
  const ms = Date.parse(j.completedAt!) - Date.parse(j.startedAt!);
  assert.ok(ms >= 100, `real duration, got ${ms} ms`);
  assert.ok(Date.parse(j.startedAt!) > Date.parse(j.requestedAt!));
});

test("old jobs (no fields, unchanged status) are never given made-up times", () => {
  const jobs = [{ id: "old", text: "x", status: "done" as const }];
  stampJobTimes([{ id: "old", status: "done" }], jobs, "2026-10-12T00:00:00.000Z");
  assert.deepEqual(jobs[0], { id: "old", text: "x", status: "done" });
  const cancelled = [{ id: "q", text: "x", status: "cancelled" as const }];
  stampJobTimes([{ id: "q", status: "queued" }], cancelled, "2026-10-12T00:00:00.000Z");
  assert.equal((cancelled[0] as { startedAt?: string }).startedAt, undefined, "never started");
});
