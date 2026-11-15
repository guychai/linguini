// Linguini projects reach T3 as projects "lp-<id>": project threads carry them, the shell lists
// them with their names, and T3's create-thread command maps them back to a projectId.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OWNED_UI_FLAGS } from "./ui-flags.ts";

const created: unknown[] = [];
(globalThis as any).sessionStorage = { getItem: () => "tok" };
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (String(url) === "/api/conversations" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    created.push(body);
    return new Response(JSON.stringify({ ...body, jobs: [], events: [] }), { status: 201 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const { configureProjects, linguiniProjectId, shell, t3ProjectId } = await import(
  "./projection.ts"
);

test("project threads map to lp-<id> T3 projects named after the Linguini project", () => {
  configureProjects([{ id: "p1", name: "Atlas" }]);
  const rows = [
    { id: "a", title: "mine", jobs: [], events: [] },
    { id: "b", title: "in p1", projectId: "p1", jobs: [], events: [] },
    { id: "c", title: "left p2", projectId: "p2", jobs: [], events: [] },
  ];
  const s = shell(rows as any);
  const byId = new Map(s.threads.map((t: any) => [t.id, t.projectId]));
  assert.deepEqual([...byId.entries()].sort(), [
    ["a", "owned-project"],
    ["b", "lp-p1"],
    ["c", "lp-p2"],
  ]);
  assert.deepEqual(
    s.projects.map((p: any) => [p.id, p.title]),
    [
      ["owned-project", "Sandbox conversations"],
      ["lp-p1", "Atlas"],
      ["lp-p2", "Project"],
    ],
  );
  assert.equal(t3ProjectId({ projectId: null }), "owned-project");
});

test("T3 project IDs map back: personal, Linguini project, or unknown", () => {
  assert.equal(linguiniProjectId("owned-project"), null);
  assert.equal(linguiniProjectId("lp-p1"), "p1");
  assert.equal(linguiniProjectId("lp-../x"), undefined);
  assert.equal(linguiniProjectId("other"), undefined);
});

test("sidebar labels only Linguini project rows", () => {
  assert.equal(OWNED_UI_FLAGS.showProjectLabel("lp-p1"), true);
  assert.equal(OWNED_UI_FLAGS.showProjectLabel("owned-project"), false);
});
