import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  realpath,
  readFile,
  stat,
  chmod,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "./store.ts";
import {
  FILES_SCRIPT,
  SandboxFiles,
  recordUserEdit,
  userEditNote,
  workspacePath,
} from "./files.ts";
import type { HandsExecRequest } from "./hands.ts";

/** Runs the real in-sandbox script locally with /workspace mapped to a temp dir. */
async function rig(
  t: { after: (f: () => unknown) => void },
  opts: { maxReadBytes?: number; maxWriteBytes?: number } = {},
) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "files-")));
  const ws = join(base, "workspace");
  await mkdir(join(ws, "src/deep"), { recursive: true });
  await writeFile(join(ws, "README.md"), "# hello\n");
  await writeFile(join(ws, "src/app.ts"), "export const x = 1;\n");
  await writeFile(join(ws, "src/deep/Notes.txt"), "héllo wörld\n");
  await writeFile(join(ws, "split.txt"), "abcé");
  await writeFile(join(ws, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  await writeFile(join(base, "secret.txt"), "outside\n");
  await symlink(join(base, "secret.txt"), join(ws, "escape.txt"));
  await symlink(base, join(ws, "escape-dir"));
  await symlink(join(ws, "src"), join(ws, "src-link"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const calls: HandsExecRequest[] = [];
  const touched: string[] = [];
  const written: string[] = [];
  let prepared = 0;
  const files = new SandboxFiles({
    prepare: async () => void prepared++,
    touch: (o, i) => void touched.push(`${o}/${i}`),
    maxEntries: 50,
    ...opts,
    exec: (_o, _i, req) => {
      calls.push(req);
      const [bin, flag, script, ...rest] = req.argv;
      assert.equal(script, FILES_SCRIPT);
      return new Promise((resolve) => {
        const child = execFile(
          bin!,
          [flag!, script!.replaceAll("/workspace", ws), ...rest],
          { encoding: "utf8", maxBuffer: 1 << 24 },
          (error, stdout, stderr) =>
            resolve({
              exitCode:
                typeof (error as { code?: unknown })?.code === "number"
                  ? (error as { code: number }).code
                  : error
                    ? 1
                    : 0,
              stdout,
              stderr,
              truncated: false,
            }),
        );
        child.stdin!.end(req.stdin ?? "");
      });
    },
    onWrite: async (o, i, path) => void written.push(`${o}/${i}:${path}`),
  });
  return { files, calls, touched, written, ws, base, prepared: () => prepared };
}

test("files: list root and subdirectories; symlinks typed by target, escapes still listed by name", async (t) => {
  const r = await rig(t);
  const root = await r.files.list("alice", "c1", "");
  const byPath = Object.fromEntries(root.entries.map((e) => [e.path, e.kind]));
  assert.equal(byPath["README.md"], "file");
  assert.equal(byPath["src"], "directory");
  assert.equal(byPath["src-link"], "directory");
  assert.equal(root.truncated, false);
  const src = await r.files.list("alice", "c1", "src");
  assert.deepEqual(src.entries.map((e) => e.path).sort(), ["src/app.ts", "src/deep"]);
  const viaLink = await r.files.list("alice", "c1", "src-link/deep");
  assert.deepEqual(viaLink.entries, [{ path: "src-link/deep/Notes.txt", kind: "file" }]);
  assert.ok(r.prepared() >= 3, "each request ensures the sandbox");
  assert.deepEqual([...new Set(r.touched)], ["alice/c1"], "browsing counts as activity");
  assert.ok(r.calls.every((c) => c.argv[0] === "bash" && c.deadlineMs > 0));
});

test("files: read text, utf-8, truncation at the byte limit, binary detection", async (t) => {
  const r = await rig(t, { maxReadBytes: 4 });
  const readme = await r.files.read("alice", "c1", "README.md");
  const { version, ...rest } = readme;
  assert.deepEqual(rest, {
    relativePath: "README.md",
    contents: "# he",
    byteLength: 8,
    truncated: true,
    binary: false,
  });
  assert.match(version, /^[0-9a-f]{64}$/, "version hashes the whole file, not the cut");
  const notes = await r.files.read("alice", "c1", "src/deep/Notes.txt");
  assert.equal(notes.contents, "hél");
  assert.equal(notes.truncated, true);
  const split = await r.files.read("alice", "c1", "split.txt");
  assert.equal(
    split.contents,
    "abc",
    "a multi-byte character cut at the limit is dropped, not mangled",
  );
  const bin = await r.files.read("alice", "c1", "blob.bin");
  assert.equal(bin.binary, true);
  assert.equal(bin.contents, "");
  const full = await (await rig(t)).files.read("alice", "c1", "src/deep/Notes.txt");
  assert.equal(full.contents, "héllo wörld\n");
  assert.equal(full.truncated, false);
});

test("files: confinement (.., absolute, symlink escapes) and missing paths", async (t) => {
  const r = await rig(t);
  for (const bad of ["../secret.txt", "/etc/passwd", "src/../../secret.txt", "~/x", "a\nb", "a\\b"])
    await assert.rejects(
      r.files.read("alice", "c1", bad),
      (e: { status: number }) => e.status === 400,
      bad,
    );
  await assert.rejects(
    r.files.read("alice", "c1", "escape.txt"),
    (e: { status: number }) => e.status === 403,
  );
  await assert.rejects(
    r.files.list("alice", "c1", "escape-dir"),
    (e: { status: number }) => e.status === 403,
  );
  await assert.rejects(
    r.files.read("alice", "c1", "nope.txt"),
    (e: { status: number }) => e.status === 404,
  );
  await assert.rejects(
    r.files.read("alice", "c1", "src"),
    (e: { status: number }) => e.status === 400,
  );
  await assert.rejects(
    r.files.list("alice", "c1", "README.md"),
    (e: { status: number }) => e.status === 400,
  );
  await assert.rejects(
    r.files.read("alice", "c1", ""),
    (e: { status: number }) => e.status === 400,
  );
  assert.equal(workspacePath("./src/"), "src");
});

test("files: search by path substring with glob characters treated literally; entry limits", async (t) => {
  const r = await rig(t);
  const s = await r.files.search("alice", "c1", "notes");
  assert.deepEqual(
    s.entries.map((e) => e.path).sort(),
    ["src/deep/Notes.txt"],
    "search does not follow symlinks",
  );
  assert.deepEqual((await r.files.search("alice", "c1", "*")).entries, [], "glob is literal");
  const small = new SandboxFiles({
    ...(r.files as unknown as { o: object }).o,
    maxEntries: 2,
  } as never);
  const listed = await small.list("alice", "c1", "");
  assert.equal(listed.entries.length <= 2, true);
  assert.equal(listed.truncated, true);
});

test("files API: POST only, owner's existing conversation only, preview pages refused", async (t) => {
  const { SqliteStore, initial } = await import("./store.ts");
  const { api } = await import("./api.ts");
  const dir = await mkdtemp(join(tmpdir(), "files-api-"));
  const store = new SqliteStore(join(dir, "s.sqlite"));
  const seen: string[] = [];
  const files = {
    list: async (o: string, i: string, p: unknown) => (
      seen.push(`list ${o} ${i} ${p}`),
      { entries: [], truncated: false }
    ),
    read: async (o: string, i: string, p: unknown) => (
      seen.push(`read ${o} ${i} ${p}`),
      { relativePath: String(p), contents: "x", byteLength: 1, truncated: false, binary: false }
    ),
    search: async (o: string, i: string, q: unknown) => (
      seen.push(`search ${o} ${i} ${q}`),
      { entries: [], truncated: false }
    ),
    write: async (o: string, i: string, p: unknown, c: unknown, v: unknown) => {
      seen.push(`write ${o} ${i} ${p} ${String(c).length} ${v}`);
      if (v !== "abc") throw new ApiError(409, "File changed", "file_changed");
      return { relativePath: String(p), version: "def" };
    },
  };
  const token = "t".repeat(40);
  const { server } = api({ store } as never, { [token]: "o" }, undefined, { files } as never);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await store.create(initial("c", "o"));
  const port = (server.address() as { port: number }).port;
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      body: JSON.stringify({ path: "src/a.ts", query: "a" }),
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  assert.equal((await call("/api/conversations/c/files/list")).status, 200);
  const read = await call("/api/conversations/c/files/read");
  assert.equal(((await read.json()) as { contents: string }).contents, "x");
  assert.equal((await call("/api/conversations/c/files/search")).status, 200);
  assert.equal(
    (await call("/api/conversations/c/files/list", { method: "GET", body: null })).status,
    405,
  );
  assert.equal((await call("/api/conversations/missing/files/list")).status, 404);
  // Writes: contents beyond the generic 1 MB body cap are accepted (up to the 5 MiB file limit).
  const big = "y".repeat(3_000_000);
  const ok = await call("/api/conversations/c/files/write", {
    body: JSON.stringify({ path: "src/a.ts", contents: big, expectedVersion: "abc" }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { relativePath: "src/a.ts", version: "def" });
  const conflict = await call("/api/conversations/c/files/write", {
    body: JSON.stringify({ path: "src/a.ts", contents: "z", expectedVersion: "old" }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { code: string }).code, "file_changed");
  assert.equal(
    (
      await call("/api/conversations/c/files/write", {
        body: JSON.stringify({ path: "src/a.ts", contents: "z", expectedVersion: "abc" }),
        headers: { referer: `http://127.0.0.1:${port}/preview/c/3000/` },
      })
    ).status,
    403,
    "a preview page cannot write files",
  );
  assert.equal((await call("/api/conversations/c/files/delete")).status, 404);
  assert.equal(
    (
      await call("/api/conversations/c/files/read", {
        headers: { referer: `http://127.0.0.1:${port}/preview/c/3000/` },
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/conversations/c/files/read", { headers: { origin: "null" } })).status,
    403,
  );
  assert.deepEqual(seen, [
    "list o c src/a.ts",
    "read o c src/a.ts",
    "search o c a",
    "write o c src/a.ts 3000000 abc",
    "write o c src/a.ts 1 old",
  ]);
});

const status = (e: unknown) => (e as { status?: number }).status;
const code = (e: unknown) => (e as { code?: string }).code;

test("files write: version from read, atomic save preserving mode, new version returned", async (t) => {
  const r = await rig(t);
  await chmod(join(r.ws, "src/app.ts"), 0o755);
  const before = await r.files.read("alice", "c1", "src/app.ts");
  assert.match(before.version, /^[0-9a-f]{64}$/);
  const saved = await r.files.write(
    "alice",
    "c1",
    "src/app.ts",
    "export const x = 2;\n",
    before.version,
  );
  assert.equal(saved.relativePath, "src/app.ts");
  assert.equal(await readFile(join(r.ws, "src/app.ts"), "utf8"), "export const x = 2;\n");
  assert.equal((await stat(join(r.ws, "src/app.ts"))).mode & 0o777, 0o755, "mode preserved");
  assert.equal(saved.version, (await r.files.read("alice", "c1", "src/app.ts")).version);
  assert.notEqual(saved.version, before.version);
  assert.deepEqual((await readdir(join(r.ws, "src"))).sort(), ["app.ts", "deep"], "no temp left");
  assert.deepEqual(r.written, ["alice/c1:src/app.ts"]);
  // The same version again is now stale: 409, file untouched.
  await assert.rejects(
    r.files.write("alice", "c1", "src/app.ts", "lost", before.version),
    (e) => status(e) === 409 && code(e) === "file_changed",
  );
  assert.equal(await readFile(join(r.ws, "src/app.ts"), "utf8"), "export const x = 2;\n");
});

test("files write: external change is a 409; new files need 'new' and an existing parent", async (t) => {
  const r = await rig(t);
  const v = (await r.files.read("alice", "c1", "README.md")).version;
  await writeFile(join(r.ws, "README.md"), "changed from the terminal\n");
  await assert.rejects(
    r.files.write("alice", "c1", "README.md", "mine", v),
    (e) => status(e) === 409,
  );
  assert.equal(await readFile(join(r.ws, "README.md"), "utf8"), "changed from the terminal\n");
  const created = await r.files.write("alice", "c1", "src/new.txt", "fresh", "new");
  assert.match(created.version, /^[0-9a-f]{64}$/);
  assert.equal((await stat(join(r.ws, "src/new.txt"))).mode & 0o777, 0o644);
  await assert.rejects(
    r.files.write("alice", "c1", "src/new.txt", "again", "new"),
    (e) => status(e) === 409,
  );
  await assert.rejects(r.files.write("alice", "c1", "gone.txt", "x", v), (e) => status(e) === 409);
  await assert.rejects(
    r.files.write("alice", "c1", "nope/a.txt", "x", "new"),
    (e) => status(e) === 404,
  );
  await assert.rejects(r.files.write("alice", "c1", "src", "x", "new"), (e) => status(e) === 400);
  await assert.rejects(
    r.files.write("alice", "c1", "README.md", "x", "bogus"),
    (e) => status(e) === 400,
  );
  await assert.rejects(r.files.write("alice", "c1", "README.md", 5, v), (e) => status(e) === 400);
});

test("files write: confinement - traversal, symlink escapes (file and parent) refused, inner links ok", async (t) => {
  const r = await rig(t);
  for (const p of ["../secret.txt", "/etc/passwd", "a/../../x"])
    await assert.rejects(
      r.files.write("alice", "c1", p, "x", "new"),
      (e) => status(e) === 400 || status(e) === 403,
    );
  await assert.rejects(
    r.files.write("alice", "c1", "escape.txt", "pwned", "new"),
    (e) => status(e) === 403,
  );
  await assert.rejects(
    r.files.write("alice", "c1", "escape-dir/secret.txt", "pwned", "new"),
    (e) => status(e) === 403,
  );
  await assert.rejects(
    r.files.write("alice", "c1", "escape-dir/new.txt", "pwned", "new"),
    (e) => status(e) === 403,
  );
  assert.equal(await readFile(join(r.base, "secret.txt"), "utf8"), "outside\n");
  assert.deepEqual((await readdir(r.base)).sort(), ["secret.txt", "workspace"]);
  // A dangling link pointing outside cannot be used to create a file there either.
  await symlink(join(r.base, "made.txt"), join(r.ws, "dangling.txt"));
  await assert.rejects(
    r.files.write("alice", "c1", "dangling.txt", "pwned", "new"),
    (e) => status(e) === 403,
  );
  assert.deepEqual((await readdir(r.base)).sort(), ["secret.txt", "workspace"]);
  const v = (await r.files.read("alice", "c1", "src-link/app.ts")).version;
  await r.files.write("alice", "c1", "src-link/app.ts", "via link", v);
  assert.equal(await readFile(join(r.ws, "src/app.ts"), "utf8"), "via link");
  assert.deepEqual(r.written, ["alice/c1:src-link/app.ts"]);
});

test("files write: size limit enforced before exec", async (t) => {
  const r = await rig(t, { maxWriteBytes: 8 });
  const v = (await r.files.read("alice", "c1", "README.md")).version;
  const n = r.calls.length;
  await assert.rejects(
    r.files.write("alice", "c1", "README.md", "123456789", v),
    (e) => status(e) === 413,
  );
  assert.equal(r.calls.length, n);
  await r.files.write("alice", "c1", "README.md", "12345678", v);
});

test("files: user edit list dedupes, caps, and the note names /workspace paths", () => {
  assert.deepEqual(recordUserEdit(["a", "b"], "a"), ["b", "a"]);
  assert.equal(
    recordUserEdit(
      Array.from({ length: 60 }, (_, i) => `f${i}`),
      "x",
    ).length,
    50,
  );
  assert.match(userEditNote(["src/a.ts"]), /\/workspace\/src\/a\.ts/);
});
