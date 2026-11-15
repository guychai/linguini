import assert from "node:assert/strict";
import { test } from "node:test";
import { joinToken, ProjectsClient, transcript } from "./projects-panel.ts";

function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: string[] = [];
  const f = (async (path: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${path}`;
    calls.push(key);
    const route = routes[key];
    const [status, body] = route
      ? route(init.body ? JSON.parse(String(init.body)) : undefined)
      : [404, { error: "Not found" }];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("projects UI only when the server serves /api/projects (Better Auth)", async () => {
  assert.equal(await new ProjectsClient(fakeFetch({}).f).enabled(), false);
  const on = fakeFetch({ "GET /api/projects": () => [200, { projects: [] }] });
  assert.equal(await new ProjectsClient(on.f).enabled(), true);
});

test("client: create, invite by email, join link, new thread carries projectId, errors surface", async () => {
  const seen: unknown[] = [];
  const { f, calls } = fakeFetch({
    "POST /api/projects": (b) => (seen.push(b), [201, { id: "p1", name: "P", role: "owner" }]),
    "POST /api/projects/p1/members": (b) => (seen.push(b), [409, { error: "Already a member" }]),
    "POST /api/projects/p1/join-link": () => [200, { token: "t", path: "/join/t" }],
    "POST /api/conversations": (b) => (seen.push(b), [201, {}]),
  });
  const c = new ProjectsClient(f);
  assert.equal((await c.create("P")).id, "p1");
  await assert.rejects(c.invite("p1", "b@x", "editor"), /Already a member/);
  assert.equal(await c.joinLink("p1", "viewer"), "/join/t");
  const id = await c.newThread("p1", "T");
  assert.match(id, /^thread-/);
  assert.deepEqual(seen, [
    { name: "P" },
    { email: "b@x", role: "editor" },
    { id, title: "T", projectId: "p1" },
  ]);
  assert.ok(calls.includes("POST /api/projects/p1/join-link"));
});

test("join links: /join/<token> only", () => {
  const t = "a".repeat(32);
  assert.equal(joinToken(`/join/${t}`), t);
  assert.equal(joinToken(`/join/${t}/`), t);
  assert.equal(joinToken("/join/short"), null);
  assert.equal(joinToken(`/x/join/${t}`), null);
});

test("shared view transcript: hidden turns say so and show nothing else", () => {
  const text = transcript({
    id: "a1",
    title: "T",
    jobs: [
      { id: "j1", text: "q3 revenue?", status: "done" },
      { id: "j2", text: "write a note", status: "done" },
    ],
    events: [
      { type: "tool.started", data: { jobId: "j1", tool: "trino_query", hidden: true } },
      { type: "assistant.delta", data: { jobId: "j1", hidden: true } },
      { type: "tool.started", data: { jobId: "j2", tool: "write" } },
      { type: "assistant.delta", data: { jobId: "j2", text: "Done." } },
    ],
    hiddenJobs: ["j1"],
  });
  assert.match(text, /q3 revenue\?[\s\S]*output is hidden/);
  assert.doesNotMatch(text, /trino_query/);
  assert.match(text, /Tools: write\nAgent: Done\./);
});
