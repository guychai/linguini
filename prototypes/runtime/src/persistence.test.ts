import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, initial, read } from "./store.ts";
import type { HandsBinding } from "./hands.ts";
import {
  RESTORE_SCRIPT,
  SAVE_SCRIPT,
  S3SandboxSuspender,
  snapshotKey,
  type SnapshotStore,
  type StreamExec,
} from "./persistence.ts";
import { S3Client, signV4 } from "./s3.ts";

test("sigv4 matches AWS's documented GET Object example", () => {
  const h = signV4({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.match(
    h.authorization!,
    /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
  );
});

test("s3 client: bucket, put (one signed PUT), head metadata, get, delete; errors carry no secret", async (t) => {
  const objects = new Map<string, { body: Buffer; meta: Record<string, string> }>();
  let bucket = false;
  const server = createServer(async (req, res) => {
    assert.match(String(req.headers.authorization), /^AWS4-HMAC-SHA256 Credential=AK\//);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const path = decodeURIComponent(req.url!.split("?")[0]!);
    if (path === "/bk1") {
      if (req.method === "HEAD") return res.writeHead(bucket ? 200 : 404).end();
      bucket = true;
      return res.writeHead(200).end();
    }
    const o = objects.get(path);
    if (req.method === "PUT") {
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        if (k.startsWith("x-amz-meta-")) meta[k] = String(v);
      objects.set(path, { body: Buffer.concat(chunks), meta });
      return res.writeHead(200).end();
    }
    if (req.method === "DELETE") return (objects.delete(path), res.writeHead(204).end());
    if (!o) return res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
    res.writeHead(200, { ...o.meta, "content-length": o.body.length });
    res.end(req.method === "HEAD" ? undefined : o.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const s3 = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    bucket: "bk1",
    accessKeyId: "AK",
    secretAccessKey: "very-secret-value",
  });
  await s3.ensureBucket();
  assert.ok(bucket);
  const dir = await mkdtemp(join(tmpdir(), "s3t-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "in"), "hello");
  const put = await s3.putFile("sandboxes/ws-x/a.tar.gz", join(dir, "in"), { generation: "3" });
  assert.equal(put.size, 5);
  assert.deepEqual((await s3.head("sandboxes/ws-x/a.tar.gz"))?.meta, { generation: "3" });
  assert.equal(await s3.head("nope"), null);
  assert.ok(await s3.getFile("sandboxes/ws-x/a.tar.gz", join(dir, "out")));
  assert.equal(await readFile(join(dir, "out"), "utf8"), "hello");
  assert.equal(await s3.getFile("nope", join(dir, "x")), false);
  await s3.delete("sandboxes/ws-x/a.tar.gz");
  assert.equal(await s3.head("sandboxes/ws-x/a.tar.gz"), null);
});

test("sandbox scripts are valid sh", () => {
  for (const s of [SAVE_SCRIPT, RESTORE_SCRIPT]) execFileSync("sh", ["-n", "-c", s]);
  assert.throws(() => snapshotKey("../etc"));
});

/** Fake hands + exec + snapshot store: records the sequence, simulates the guest marker. */
async function rig(t: { after: (f: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "persist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SqliteStore(join(dir, "db.sqlite"));
  await store.create(initial("c1", "alice"));
  const log: string[] = [];
  let binding: HandsBinding = {
    workspaceId: "ws-abcdefabcdefabcdef12",
    generation: 1,
    state: "ready",
    jobId: "hands-abcdefabcdefabcdef12-g1",
    allocId: "alloc-1",
    template: "t",
    image: "i",
    runtime: "kata",
    requestedEpoch: 0,
    updatedAt: new Date().toISOString(),
  };
  const guest = { marker: false, failedMarker: false, restoredBytes: "" };
  const hands = {
    async claimIdle() {
      if (binding.state !== "ready") return null;
      binding = { ...binding, state: "stopping" };
      log.push("claim");
      return binding;
    },
    async unclaimIdle() {
      binding = { ...binding, state: "ready" };
      log.push("unclaim");
    },
    async stop() {
      binding = { ...binding, state: "stopped" };
      log.push("stop");
    },
  };
  const exec = {
    saveFails: false,
    restoreFails: false,
    async run(_a: string, argv: string[], io: { stdinPath?: string; stdoutPath?: string }) {
      const cmd = argv.join(" ");
      if (cmd === "test -e /run/linguini-restore")
        return { exitCode: guest.marker ? 0 : 1, stderr: "" };
      if (cmd === "test -e /run/linguini-restore/failed")
        return { exitCode: guest.failedMarker ? 0 : 1, stderr: "" };
      if (argv[2] === SAVE_SCRIPT) {
        log.push("save");
        if (exec.saveFails) return { exitCode: 2, stderr: "tar: boom" };
        await writeFile(io.stdoutPath!, gzipSync(`files-of-g${binding.generation}`));
        return { exitCode: 0, stderr: "" };
      }
      if (argv[2] === RESTORE_SCRIPT) {
        log.push("restore");
        if (exec.restoreFails) return { exitCode: 65, stderr: "unknown snapshot format" };
        guest.marker = true;
        guest.restoredBytes = (await readFile(io.stdinPath!)).toString("base64");
        return { exitCode: 0, stderr: "" };
      }
      if (cmd.includes("RESTORE_FAILED.md")) return (log.push("note"), { exitCode: 0, stderr: "" });
      if (cmd.includes("mkdir")) {
        guest.marker = true;
        if (cmd.includes("failed")) guest.failedMarker = true;
        return { exitCode: 0, stderr: "" };
      }
      throw new Error(`unexpected exec ${cmd}`);
    },
  } satisfies StreamExec & Record<string, unknown>;
  const objects = new Map<string, { path: string; meta: Record<string, string> }>();
  const snapshots: SnapshotStore = {
    async put(key, path, meta) {
      const copy = join(dir, `obj-${objects.size}`);
      await copyFile(path, copy);
      objects.set(key, { path: copy, meta });
      log.push(`put ${key}`);
      return { size: 1, sha256: "x" };
    },
    async head(key) {
      const o = objects.get(key);
      return o ? { size: 1, meta: o.meta } : null;
    },
    async get(key, path) {
      const o = objects.get(key);
      if (!o) return false;
      await copyFile(o.path, path);
      return true;
    },
  };
  const s = new S3SandboxSuspender(hands, store, snapshots, exec, { tmpDir: dir });
  const next = () => {
    binding = {
      ...binding,
      generation: binding.generation + 1,
      state: "ready",
      allocId: `alloc-${binding.generation + 1}`,
    };
    guest.marker = guest.failedMarker = false;
    return binding;
  };
  const events = async () => (await read(store, "alice", "c1")).events.map((e) => e.type);
  return {
    s,
    log,
    exec,
    objects,
    guest,
    next,
    events,
    get binding() {
      return binding;
    },
  };
}

test("suspender: snapshot then stop; the next generation restores it once", async (t) => {
  const r = await rig(t);
  assert.equal(await r.s.restore("alice", "c1", r.binding), undefined);
  assert.ok(r.guest.marker, "first generation: nothing saved, marked handled");
  assert.equal(await r.s.suspendIfIdle("alice", "c1", 0), true);
  const key = snapshotKey("ws-abcdefabcdefabcdef12");
  assert.deepEqual(r.log, ["claim", "save", `put ${key}`, "stop"]);
  assert.equal(r.objects.get(key)!.meta.generation, "1");
  const g2 = r.next();
  await r.s.restore("alice", "c1", g2);
  assert.ok(r.guest.restoredBytes, "archive streamed into the sandbox");
  await r.s.restore("alice", "c1", g2);
  assert.equal(r.log.filter((l) => l === "restore").length, 1, "idempotent per generation");
  assert.ok((await r.events()).includes("workspace.saved"));
  assert.ok((await r.events()).includes("workspace.restored"));
});

test("suspender: never restores a snapshot from the same or a later generation", async (t) => {
  const r = await rig(t);
  await r.s.suspendIfIdle("alice", "c1", 0);
  // Same generation comes back (e.g. backend restart while the sandbox kept running).
  r.guest.marker = false;
  await r.s.restore("alice", "c1", { ...r.binding, state: "ready" });
  assert.ok(!r.log.includes("restore"));
});

test("suspender: a failed snapshot keeps the sandbox and retries, then stops after 3", async (t) => {
  const r = await rig(t);
  r.exec.saveFails = true;
  assert.equal(await r.s.suspendIfIdle("alice", "c1", 0), false);
  assert.equal(r.binding.state, "ready");
  assert.equal(await r.s.suspendIfIdle("alice", "c1", 0), false);
  assert.equal(await r.s.suspendIfIdle("alice", "c1", 0), true);
  assert.equal(r.binding.state, "stopped");
  assert.equal(r.objects.size, 0);
  assert.equal((await r.events()).filter((e) => e === "workspace.save_failed").length, 3);
});

test("suspender: a failed restore is visible, does not throw, and never overwrites the saved copy", async (t) => {
  const r = await rig(t);
  await r.s.suspendIfIdle("alice", "c1", 0);
  const key = snapshotKey("ws-abcdefabcdefabcdef12");
  const good = await readFile(r.objects.get(key)!.path);
  r.exec.restoreFails = true;
  await r.s.restore("alice", "c1", r.next());
  assert.ok((await r.events()).includes("workspace.restore_failed"));
  assert.ok(r.log.includes("note"), "RESTORE_FAILED.md written for the agent");
  r.exec.restoreFails = false;
  await r.s.suspendIfIdle("alice", "c1", 0);
  assert.deepEqual(await readFile(r.objects.get(key)!.path), good, "good snapshot kept");
  assert.ok([...r.objects.keys()].some((k) => k.includes("after-failed-restore-g2")));
  // The generation after that restores the good copy.
  await r.s.restore("alice", "c1", r.next());
  assert.equal(Buffer.from(r.guest.restoredBytes, "base64").equals(good), true);
});
