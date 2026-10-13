import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationFromPath, fileCommand, relativeToWorkspace } from "./files-client.ts";

test("files client: conversation from the thread route; drafts and other pages have none", () => {
  assert.equal(conversationFromPath("/owned-abc/conv-1"), "conv-1");
  assert.equal(conversationFromPath("/draft/x"), null);
  assert.equal(conversationFromPath("/settings/general"), null);
  assert.equal(conversationFromPath("/"), null);
  assert.equal(conversationFromPath("/a/b/c"), null);
  assert.equal(relativeToWorkspace("/workspace/src/a.ts"), "src/a.ts");
  assert.equal(relativeToWorkspace("/workspace"), "");
  assert.throws(() => relativeToWorkspace("/etc/passwd"));
});

test("files client: maps T3 RPCs to the owned files API", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const replies: Record<string, unknown> = {
    list: { entries: [{ path: "src", kind: "directory" }], truncated: false },
    read: { relativePath: "a.txt", contents: "hi", byteLength: 2, truncated: false, binary: false },
    search: {
      entries: [
        { path: "src", kind: "directory" },
        { path: "src/a.ts", kind: "file" },
      ],
      truncated: false,
    },
  };
  const deps = {
    token: () => "tok",
    location: { pathname: "/env/conv-1" },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(replies[url.split("/").at(-1)!]), { status: 200 });
    }) as typeof fetch,
  };
  assert.deepEqual(
    await fileCommand("projects.listEntries", { cwd: "/workspace", directoryPath: "" }, deps),
    replies.list,
  );
  assert.deepEqual(
    await fileCommand("projects.readFile", { cwd: "/workspace", relativePath: "a.txt" }, deps),
    {
      relativePath: "a.txt",
      contents: "hi",
      byteLength: 2,
      truncated: false,
    },
  );
  const s = await fileCommand(
    "projects.searchEntries",
    { cwd: "/workspace", query: "a", limit: 5, kind: "file" },
    deps,
  );
  assert.deepEqual(s, { entries: [{ path: "src/a.ts", kind: "file" }], truncated: false });
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "/api/conversations/conv-1/files/list",
      "/api/conversations/conv-1/files/read",
      "/api/conversations/conv-1/files/search",
    ],
  );
  await assert.rejects(fileCommand("projects.listEntries", { cwd: "/home" }, deps));
  await assert.rejects(
    fileCommand(
      "projects.listEntries",
      { cwd: "/workspace" },
      { ...deps, location: { pathname: "/draft/x" } },
    ),
    /Send a message/,
  );
  replies.read = {
    relativePath: "b.bin",
    contents: "",
    byteLength: 9,
    truncated: false,
    binary: true,
  };
  await assert.rejects(
    fileCommand("projects.readFile", { cwd: "/workspace", relativePath: "b.bin" }, deps),
    /binary/,
  );
});

test("files client: writeFile sends the read version, then its own; 409 becomes a clear conflict", async () => {
  const { resetFileVersions } = await import("./files-client.ts");
  resetFileVersions();
  const writes: unknown[] = [];
  const notices: Array<string | null> = [];
  let conflict = false;
  const deps = {
    notify: (t: string | null) => void notices.push(t),
    token: () => "tok",
    location: { pathname: "/env/conv-1" },
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/read"))
        return Response.json({
          relativePath: body.path,
          contents: "x",
          byteLength: 1,
          truncated: body.path === "big.txt",
          binary: false,
          version: `v-${body.path}`,
        });
      writes.push(body);
      if (conflict)
        return Response.json({ error: "File changed", code: "file_changed" }, { status: 409 });
      return Response.json({ relativePath: body.path, version: `v${writes.length + 1}` });
    }) as typeof fetch,
  };
  const w = (relativePath: string, contents = "new") =>
    fileCommand("projects.writeFile", { cwd: "/workspace", relativePath, contents }, deps);
  await fileCommand("projects.readFile", { cwd: "/workspace", relativePath: "a.txt" }, deps);
  assert.deepEqual(await w("a.txt"), { relativePath: "a.txt" });
  await w("/workspace/a.txt");
  await w("fresh.txt");
  assert.deepEqual(
    writes.map((b) => (b as { expectedVersion: string }).expectedVersion),
    ["v-a.txt", "v2", "new"],
  );
  conflict = true;
  await assert.rejects(w("a.txt"), /changed in the sandbox since you opened it/);
  await fileCommand("projects.readFile", { cwd: "/workspace", relativePath: "big.txt" }, deps);
  const n = writes.length;
  await assert.rejects(w("big.txt"), /partly loaded/);
  await assert.rejects(w("a.txt", "z".repeat(5 * 1024 * 1024 + 1)), /larger than 5 MiB/);
  assert.equal(writes.length, n, "refused locally");
  assert.deepEqual(notices.slice(0, 3), [null, null, null], "successful saves clear the notice");
  assert.match(String(notices[3]), /changed in the sandbox/);
  assert.equal(notices.length, 6, "every failed save is shown");
});
