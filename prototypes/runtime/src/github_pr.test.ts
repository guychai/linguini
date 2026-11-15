// github_create_pr: backend-only publishing App, off unless configured; change set read from the
// sandbox with real git; Git Data API against a fake GitHub; idempotent retry; allowlist,
// entitlement, public-repo refusal, workflow refusal, credential scan and the co-author line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANGESET_SCRIPT,
  GitHubPublisher,
  githubCreatePrTool,
  parseChangeSet,
  publishBranch,
  publishConfigFromEnv,
} from "./github_pr.ts";
import { HostToolRegistry } from "./host-tools.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import { SqliteStore, initial } from "./store.ts";

test("config: off unless app id, key file and repos are all set", () => {
  const full = {
    GITHUB_PUBLISH_APP_ID: "123",
    GITHUB_PUBLISH_KEY_FILE: "/etc/linguini/publish.pem",
    GITHUB_PUBLISH_REPOS: "Acme/App, acme/docs",
  };
  const c = publishConfigFromEnv(full)!;
  assert.deepEqual([...c.repos], ["acme/app", "acme/docs"]);
  assert.equal(c.apiUrl, "https://api.github.com");
  for (const k of Object.keys(full))
    assert.equal(publishConfigFromEnv({ ...full, [k]: "" }), undefined, k);
  assert.throws(() => publishConfigFromEnv({ ...full, GITHUB_PUBLISH_REPOS: "acme" }));
  assert.throws(() => publishConfigFromEnv({ ...full, GITHUB_PUBLISH_APP_ID: "abc" }));
});

test("branch names are always linguini/<slug>-<exec>", () => {
  assert.equal(
    publishBranch("Fix the Login bug!", "exec-12345678abcd"),
    "linguini/fix-the-login-bug-5678abcd",
  );
  assert.equal(publishBranch("linguini/../main", "e1"), "linguini/main-e1");
  assert.equal(publishBranch("///", "e1"), "linguini/change-e1");
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
  });

async function repoWithChanges(root: string) {
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  await writeFile(join(work, "keep.txt"), "keep\n");
  await writeFile(join(work, "edit.txt"), "old\n");
  await writeFile(join(work, "gone.txt"), "bye\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "base");
  git(work, "push", "-q", "origin", "main");
  const base = git(work, "rev-parse", "HEAD").trim();
  // A local commit plus uncommitted, unstaged and untracked changes all count.
  await writeFile(join(work, "edit.txt"), "new\n");
  git(work, "commit", "-qam", "local");
  await mkdir(join(work, "src"));
  await writeFile(join(work, "src", "new file.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(work, "src", "new file.sh"), 0o755);
  await rm(join(work, "gone.txt"));
  await writeFile(join(work, ".gitignore"), "ignored.log\n");
  await writeFile(join(work, "ignored.log"), "x\n");
  return { work, base };
}

/** Like hands exec: stdout whatever the exit code. */
const runScript = (dir: string, base: string) => {
  try {
    return execFileSync("bash", ["-c", CHANGESET_SCRIPT, "linguini-changes", dir, base], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "");
  }
};

test("change set script: commits, worktree edits, untracked, deletions; index untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ghpr-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { work, base } = await repoWithChanges(root);
  const statusBefore = git(work, "status", "--porcelain");
  const cs = parseChangeSet(runScript(work, "main"));
  assert.equal(cs.base, base);
  const byPath = Object.fromEntries(cs.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), [
    ".gitignore",
    "edit.txt",
    "gone.txt",
    "src/new file.sh",
  ]);
  assert.equal(byPath["gone.txt"]!.status, "D");
  assert.equal(Buffer.from(byPath["edit.txt"]!.content!, "base64").toString(), "new\n");
  assert.equal(byPath["src/new file.sh"]!.mode, "100755");
  assert.equal(git(work, "status", "--porcelain"), statusBefore);
  assert.throws(() => parseChangeSet(runScript(work, "nope")), /origin\/nope not found/);
  assert.throws(
    () => parseChangeSet(runScript(join(root, "missing"), "main")),
    /no such directory/,
  );
  // Workflows are refused before anything leaves.
  await mkdir(join(work, ".github", "workflows"), { recursive: true });
  await writeFile(join(work, ".github", "workflows", "ci.yml"), "on: push\n");
  assert.throws(
    () => parseChangeSet(runScript(work, "main")),
    (e: { code?: string }) => e.code === "github_workflow_change",
  );
});

/** Minimal GitHub: verifies the App JWT, tracks blobs/trees/commits/refs/pulls. */
function fakeGitHub(publicKey: string, base: string) {
  const calls: string[] = [];
  const state = {
    blobs: new Map<string, string>(),
    trees: [] as unknown[],
    commits: [] as Array<{ message: string; parents: string[] }>,
    refs: new Map<string, string>(),
    pulls: [] as Array<{ head: string; base: string; title: string; html_url: string }>,
    tokenRequests: [] as unknown[],
  };
  let n = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const auth = (init.headers as Record<string, string>).authorization ?? "";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname.startsWith("/app/") || u.pathname.endsWith("/installation")) {
      const [h, p, s] = auth.replace("Bearer ", "").split(".");
      const ok = createVerify("RSA-SHA256")
        .update(`${h}.${p}`)
        .verify(publicKey, Buffer.from(s!, "base64url"));
      if (!ok || JSON.parse(Buffer.from(p!, "base64url").toString()).iss !== "123")
        return json(401, {});
      if (["/repos/acme/app/installation", "/repos/acme/pub/installation"].includes(u.pathname))
        return json(200, { id: 7 });
      if (u.pathname.endsWith("/installation")) return json(404, {});
      state.tokenRequests.push(body);
      return json(201, {
        token: "ghs_test",
        expires_at: new Date(Date.now() + 3600e3).toISOString(),
      });
    }
    if (auth !== "Bearer ghs_test") return json(401, {});
    if (method === "GET" && u.pathname === "/repos/acme/pub")
      return json(200, { default_branch: "main", private: false, visibility: "public" });
    const p = u.pathname.replace("/repos/acme/app", "");
    if (method === "GET" && p === "")
      return json(200, { default_branch: "main", private: true, visibility: "private" });
    if (method === "GET" && p === "/pulls") {
      const head = u.searchParams.get("head")!.split(":")[1];
      return json(
        200,
        state.pulls.filter((x) => x.head === head),
      );
    }
    if (method === "GET" && p === `/git/commits/${base}`)
      return json(200, { tree: { sha: "basetree" } });
    if (method === "GET" && p.startsWith("/git/commits/")) return json(404, {});
    if (method === "POST" && p === "/git/blobs") {
      const sha = `blob${++n}`;
      state.blobs.set(sha, Buffer.from(body.content, "base64").toString());
      return json(201, { sha });
    }
    if (method === "POST" && p === "/git/trees") {
      state.trees.push(body);
      return json(201, { sha: "tree1" });
    }
    if (method === "POST" && p === "/git/commits") {
      state.commits.push(body);
      return json(201, { sha: "commit1" });
    }
    if (method === "POST" && p === "/git/refs") {
      if (state.refs.has(body.ref)) return json(422, {});
      state.refs.set(body.ref, body.sha);
      return json(201, {});
    }
    if (method === "POST" && p === "/pulls") {
      const pr = {
        ...body,
        html_url: `https://github.com/acme/app/pull/${state.pulls.length + 1}`,
      };
      state.pulls.push(pr);
      return json(201, pr);
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  return { fetcher, state, calls };
}

async function setup(t: { after(f: () => unknown): void }, identity = true) {
  const root = await mkdtemp(join(tmpdir(), "ghpr-"));
  const store = new SqliteStore(join(root, "state.sqlite"));
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyFile = join(root, "publish.pem");
  await writeFile(keyFile, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  const { work, base } = await repoWithChanges(root);
  const gh = fakeGitHub(publicKey.export({ type: "spki", format: "pem" }) as string, base);
  const config = publishConfigFromEnv({
    GITHUB_PUBLISH_APP_ID: "123",
    GITHUB_PUBLISH_KEY_FILE: keyFile,
    GITHUB_PUBLISH_REPOS: "acme/app,acme/other,acme/pub",
    GITHUB_PUBLISH_API_URL: "https://gh.test",
  })!;
  const reads: Array<{ dir: string; base: string; owner: string }> = [];
  const tool = githubCreatePrTool({
    config,
    publisher: new GitHubPublisher(config, gh.fetcher),
    readChanges: async (run, dir, b) => {
      reads.push({ dir, base: b, owner: run.owner });
      return runScript(work, b);
    },
    ...(identity
      ? {
          identityOf: async (owner: string) =>
            owner === "alice"
              ? { name: "Alice <Example>", email: "alice@corp.example" }
              : undefined,
        }
      : {}),
  });
  // Entitlements: bob is not allowed github_create_pr.
  const broker = new SandboxBroker(store, new FixtureSandbox(), {
    hostTools: new HostToolRegistry({ github_create_pr: tool }),
    entitled: (c, tool) => {
      if (c.owner === "bob" && tool === "github_create_pr")
        throw Object.assign(new Error(`"github_create_pr" is not enabled for your account`), {
          status: 403,
        });
    },
  });
  for (const owner of ["alice", "bob"]) await store.create(initial(`c-${owner}`, owner));
  return { store, broker, gh, reads, base, work };
}

test("github_create_pr: blobs, tree, commit on the merge base, linguini/ branch, PR; scoped token", async (t) => {
  const { broker, gh, reads, base } = await setup(t);
  const r = await broker.execute("alice", "c-alice", {
    id: "pr1",
    tool: "github_create_pr",
    args: { repo: "acme/app", title: "Fix edit", body: "Details" },
  });
  assert.match(
    r.text,
    /^Opened https:\/\/github.com\/acme\/app\/pull\/1 \(4 files, branch linguini\/fix-edit-/,
  );
  assert.match(r.text, /credits you \(Alice Example <alice@corp.example>\)/);
  assert.deepEqual(reads, [{ dir: "/workspace/app", base: "main", owner: "alice" }]);
  assert.deepEqual(gh.state.tokenRequests, [
    {
      repositories: ["app"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    },
  ]);
  const tree = gh.state.trees[0] as {
    base_tree: string;
    tree: Array<{ path: string; sha: string | null; mode: string }>;
  };
  assert.equal(tree.base_tree, "basetree");
  const entries = Object.fromEntries(tree.tree.map((e) => [e.path, e]));
  assert.equal(entries["gone.txt"]!.sha, null);
  assert.equal(entries["src/new file.sh"]!.mode, "100755");
  assert.equal(gh.state.blobs.get(entries["edit.txt"]!.sha!), "new\n");
  assert.deepEqual(gh.state.commits, [
    {
      message: "Fix edit\n\nDetails\n\nCo-authored-by: Alice Example <alice@corp.example>",
      tree: "tree1",
      parents: [base],
    },
  ]);
  const [ref] = [...gh.state.refs.keys()];
  assert.match(ref!, /^refs\/heads\/linguini\/fix-edit-[a-z0-9]+$/);
  assert.equal(gh.state.pulls[0]!.base, "main");
  assert.equal(`refs/heads/${gh.state.pulls[0]!.head}`, ref);
});

test("github_create_pr: retry of the same execution returns the existing PR", async (t) => {
  const { broker, gh } = await setup(t);
  const call = { id: "pr1", tool: "github_create_pr", args: { repo: "acme/app", title: "Fix" } };
  await broker.execute("alice", "c-alice", call);
  // Simulate an unknown outcome being retried by the same exec: the handler sees the PR first.
  const pr = gh.state.pulls[0]!;
  const blobsBefore = gh.state.blobs.size;
  const execId = pr.head.split("-").at(-1)!;
  const again = await githubCreatePrTool({
    config: publishConfigFromEnv({
      GITHUB_PUBLISH_APP_ID: "123",
      GITHUB_PUBLISH_KEY_FILE: "/nonexistent",
      GITHUB_PUBLISH_REPOS: "acme/app",
    })!,
    publisher: {
      token: async () => "ghs_test",
      request: (m: string, p: string, a: string, b?: unknown) =>
        new GitHubPublisher(
          { appId: "123", keyFile: "/x", apiUrl: "https://gh.test" },
          gh.fetcher,
        ).request(m, p, a, b),
    } as unknown as GitHubPublisher,
    readChanges: async () => assert.fail("must not read changes again"),
  }).handler(call, { owner: "alice", conversationId: "c-alice", execId, epoch: 1 } as never);
  assert.equal(again.text, `Pull request already open: ${pr.html_url}`);
  assert.equal(gh.state.blobs.size, blobsBefore);
  assert.equal(gh.state.pulls.length, 1);
});

test("github_create_pr: allowlist, entitlement, App not installed, public repo refused", async (t) => {
  const { broker, gh } = await setup(t);
  const pr = (owner: string, repo: string, id = "x") =>
    broker.execute(owner, `c-${owner}`, {
      id,
      tool: "github_create_pr",
      args: { repo, title: "T" },
    });
  await assert.rejects(pr("alice", "acme/secret"), /may not write to github/);
  await assert.rejects(pr("bob", "acme/app"), /not enabled for your account/);
  await assert.rejects(
    pr("alice", "acme/other", "y"),
    (e: { code?: string }) => e.code === "github_not_installed",
  );
  await assert.rejects(
    pr("alice", "acme/pub", "p"),
    (e: { code?: string }) => e.code === "github_public_repo",
  );
  assert.equal(gh.state.pulls.length, 0);
  assert.equal(gh.state.blobs.size, 0);
});

test("github_create_pr: a credential in the change set is refused before anything is uploaded", async (t) => {
  const { broker, gh, work } = await setup(t);
  // A fake AWS-style key ID, built at runtime so this file holds no credential-shaped literal.
  await writeFile(join(work, "config.env"), `KEY=${"AKIA" + "Z".repeat(16)}\n`);
  await assert.rejects(
    broker.execute("alice", "c-alice", {
      id: "s1",
      tool: "github_create_pr",
      args: { repo: "acme/app", title: "T" },
    }),
    (e: { code?: string; message: string }) =>
      e.code === "github_secret_in_changes" && /config\.env .*aws-access-key/.test(e.message),
  );
  assert.equal(gh.state.blobs.size, 0);
  assert.equal(gh.state.pulls.length, 0);
});

test("github_create_pr: no email, no co-author line", async (t) => {
  const { broker, gh } = await setup(t, false);
  const r = await broker.execute("alice", "c-alice", {
    id: "n1",
    tool: "github_create_pr",
    args: { repo: "acme/app", title: "Plain" },
  });
  assert.doesNotMatch(r.text, /credits you/);
  assert.equal(gh.state.commits[0]!.message, "Plain");
});

test("co-author line: display name and login email, sanitized; falls back to the local part", async () => {
  const { coAuthorTrailer } = await import("./github_pr.ts");
  assert.equal(
    coAuthorTrailer({ name: " Jane\nDoe ", email: "jane@corp.example" }),
    "Co-authored-by: Jane Doe <jane@corp.example>",
  );
  assert.equal(
    coAuthorTrailer({ name: "", email: "jane@corp.example" }),
    "Co-authored-by: jane <jane@corp.example>",
  );
  for (const email of [undefined, "", "no-at", "a b@c", "<x>@y"])
    assert.equal(coAuthorTrailer({ name: "X", email }), undefined, String(email));
});
