// Members' read-only view of project threads: audience-gated, and trino_query output (plus the
// assistant text of that turn) hidden from members without the entitlement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudienceCheck } from "./audience.ts";
import { Entitlements, MemoryRules } from "./entitlements.ts";
import { SharedThreads, redactEvents } from "./shared-threads.ts";
import { SqliteStore, append, initial } from "./store.ts";

async function rig(t: { after(f: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "shared-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const audience = new AudienceCheck(store, {
    members: async (p) => (p === "p1" ? ["alice", "bob", "carol"] : []),
  });
  const rules = new MemoryRules();
  const entitlements = await new Entitlements(rules, async () => []).load();
  await entitlements.replace(
    "admin",
    [
      {
        subject: { type: "user", id: "carol" },
        object: { type: "tool", name: "trino_query" },
        effect: "allow",
      },
    ],
    "test",
  );
  const shared = new SharedThreads({
    store,
    audience,
    canSee: (viewer, tool, projectId) =>
      entitlements.allowed(viewer, { type: "tool", name: tool }, projectId),
  });
  await store.create({ ...initial("a1", "alice", "Revenue"), projectId: "p1" });
  await store.mutate("alice", "a1", (c) => {
    c.jobs.push({ id: "j1", text: "q3 revenue?", status: "done" } as never);
    append(c, "message.user", { jobId: "j1", text: "q3 revenue?" });
    append(c, "tool.started", { jobId: "j1", tool: "trino_query", args: { sql: "select 1" } });
    append(c, "tool.output", { jobId: "j1", tool: "trino_query", text: "acme\t120.5" });
    append(c, "assistant.delta", { jobId: "j1", text: "Acme made 120.5" });
    append(c, "run.completed", { jobId: "j1" });
    c.jobs.push({ id: "j2", text: "write a note", status: "done" } as never);
    append(c, "message.user", { jobId: "j2", text: "write a note" });
    append(c, "tool.started", { jobId: "j2", tool: "write", args: { path: "n.md" } });
    append(c, "assistant.delta", { jobId: "j2", text: "Done." });
  });
  await store.create(initial("loose", "alice"));
  return { store, shared };
}

const texts = (events: Array<{ type: string; data: Record<string, unknown> }>) =>
  events.map((e) => `${e.type}:${String(e.data.text ?? (e.data.hidden ? "hidden" : ""))}`);

test("a member without trino_query sees the prompt and status, not the rows or the answer", async (t) => {
  const { shared } = await rig(t);
  const v = await shared.view("bob", "alice", "a1");
  assert.equal(v.readOnly, true);
  assert.deepEqual(v.hiddenJobs, ["j1"]);
  const dump = JSON.stringify(v.events);
  assert.doesNotMatch(dump, /acme|120\.5|select 1/);
  assert.deepEqual(texts(v.events).slice(-8), [
    "message.user:q3 revenue?",
    "tool.started:hidden",
    "tool.output:hidden",
    "assistant.delta:hidden",
    "run.completed:",
    "message.user:write a note",
    "tool.started:",
    "assistant.delta:Done.",
  ]);
  assert.ok(texts(v.events).includes("assistant.delta:Done."), "other turns stay visible");
});

test("an entitled member and the owner see everything", async (t) => {
  const { shared } = await rig(t);
  for (const who of ["carol", "alice"]) {
    const v = await shared.view(who, "alice", "a1");
    assert.deepEqual(v.hiddenJobs, []);
    assert.match(JSON.stringify(v.events), /acme\\t120\.5/);
  }
  assert.equal((await shared.view("alice", "alice", "a1")).readOnly, false);
});

test("non-members and threads outside the project: 404", async (t) => {
  const { shared } = await rig(t);
  await assert.rejects(shared.view("dave", "alice", "a1"), { status: 404 });
  await assert.rejects(shared.view("bob", "alice", "loose"), { status: 404 });
  assert.equal(await shared.allowed("bob", "alice", "a1"), "alice");
  assert.equal(await shared.allowed("dave", "alice", "a1"), undefined);
  assert.equal(await shared.allowed("bob", "alice", "missing"), undefined);
});

test("redactEvents: events of other tools and turns pass unchanged", () => {
  const ev = (type: string, data: Record<string, unknown>) =>
    ({ seq: 1, type, timestamp: "t", data }) as never;
  const { events, hiddenJobs } = redactEvents(
    [ev("tool.output", { jobId: "x", tool: "read", text: "file" })],
    () => false,
  );
  assert.deepEqual(hiddenJobs, []);
  assert.equal((events[0] as unknown as { data: { text: string } }).data.text, "file");
});
