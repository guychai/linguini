/**
 * Host-side `github_create_pr`: the backend-only **publishing App**.
 *
 * Two Apps: the egress proxy's reader App stays read-only; this one's key is readable only by the
 * backend. Off unless configured: GITHUB_PUBLISH_APP_ID, GITHUB_PUBLISH_KEY_FILE and
 * GITHUB_PUBLISH_REPOS (allowlist). Who may publish is the `github_create_pr` entitlement
 * (entitlements.ts), checked by the broker before the call runs.
 *
 * Flow: the host reads the change set out of the sandbox (one bash script over the hands exec
 * transport: changed paths and blob contents against the merge base with origin/<base>), scans it
 * for credentials, then creates blobs, a tree, a commit, the `linguini/…` branch and the PR
 * through GitHub's API as the App (GitHub signs App API commits). No push from the sandbox, no
 * workflow permission, a token minted per call for one repository.
 *
 * Policy: non-idempotent publication. Refused: a repo outside the allowlist, a repo GitHub reports
 * as public (the data may be internal; publishing there is a leak), changes to .github/workflows
 * and change sets carrying a well-known credential format. The commit carries
 * `Co-authored-by: <display name> <login email>` (convention: the login email is the user's
 * GitHub email; no account linking, no lookup). A retry finds its branch/PR by the execution ID
 * instead of creating a second one.
 */
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { HostTool, HostToolRun } from "./host-tools.ts";
import { ApiError } from "./store.ts";

export interface PublishConfig {
  appId: string;
  keyFile: string;
  repos: ReadonlySet<string>;
  apiUrl: string;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** The publishing App config, or undefined (tool off) when anything is missing. */
export function publishConfigFromEnv(env: NodeJS.ProcessEnv): PublishConfig | undefined {
  const list = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const appId = env.GITHUB_PUBLISH_APP_ID?.trim();
  const keyFile = env.GITHUB_PUBLISH_KEY_FILE?.trim();
  const repos = list(env.GITHUB_PUBLISH_REPOS).map((r) => r.toLowerCase());
  if (!appId || !keyFile || !repos.length) return undefined;
  if (!/^\d+$/.test(appId)) throw new Error("GITHUB_PUBLISH_APP_ID must be the numeric App ID");
  for (const r of repos)
    if (!REPO.test(r)) throw new Error(`GITHUB_PUBLISH_REPOS: invalid repo ${JSON.stringify(r)}`);
  return {
    appId,
    keyFile,
    repos: new Set(repos),
    apiUrl: (env.GITHUB_PUBLISH_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
  };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** GitHub REST client for the publishing App: JWT, per-repo installation tokens, Git Data API. */
export class GitHubPublisher {
  private jwt?: { token: string; until: number };
  private tokens = new Map<string, { token: string; until: number }>();
  private readonly c: Pick<PublishConfig, "appId" | "keyFile" | "apiUrl">;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(
    c: Pick<PublishConfig, "appId" | "keyFile" | "apiUrl">,
    fetcher: typeof fetch = fetch,
    now: () => number = () => Date.now(),
  ) {
    this.c = c;
    this.fetcher = fetcher;
    this.now = now;
  }
  private async appJwt() {
    const now = Math.floor(this.now() / 1000);
    if (this.jwt && this.jwt.until > now) return this.jwt.token;
    const key = await readFile(this.c.keyFile, "utf8");
    const body = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.c.appId }),
    )}`;
    const sig = createSign("RSA-SHA256").update(body).sign(key);
    this.jwt = { token: `${body}.${b64url(sig)}`, until: now + 480 };
    return this.jwt.token;
  }
  async request<T = any>(
    method: string,
    path: string,
    auth: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; data: T }> {
    const r = await this.fetcher(`${this.c.apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: auth,
        "x-github-api-version": "2022-11-28",
        "user-agent": "linguini-publisher",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const data = (await r.json().catch(() => ({}))) as T;
    return { status: r.status, data };
  }
  /** An installation token for exactly this repository (contents + pull requests write). */
  async token(repo: string, signal?: AbortSignal) {
    const cached = this.tokens.get(repo);
    if (cached && cached.until > this.now()) return cached.token;
    const jwt = `Bearer ${await this.appJwt()}`;
    const inst = await this.request("GET", `/repos/${repo}/installation`, jwt, undefined, signal);
    if (inst.status !== 200)
      throw new ApiError(
        403,
        `The publishing App is not installed on ${repo}`,
        "github_not_installed",
      );
    const name = repo.split("/")[1];
    const t = await this.request(
      "POST",
      `/app/installations/${inst.data.id}/access_tokens`,
      jwt,
      {
        repositories: [name],
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      },
      signal,
    );
    if (t.status !== 201 || typeof t.data.token !== "string")
      throw new ApiError(502, `Could not get a token for ${repo}`, "github_token_failed");
    const until = Math.min(Date.parse(t.data.expires_at) || 0, this.now() + 50 * 60_000) - 60_000;
    this.tokens.set(repo, { token: t.data.token, until });
    return t.data.token as string;
  }
}

export interface ChangedFile {
  path: string;
  status: "A" | "M" | "D" | "T";
  mode: "100644" | "100755" | "120000";
  /** base64 content (absent for deletions). */
  content?: string;
}
export interface ChangeSet {
  base: string;
  files: ChangedFile[];
}
export const CHANGE_LIMITS = { files: 300, fileBytes: 1024 * 1024, totalBytes: 8 * 1024 * 1024 };

/**
 * Runs in the sandbox (bash, git). Prints `BASE <sha>` then one line per changed path:
 * `<status> <mode> <base64 path> <base64 content or ->`. Uses a temporary index, so the user's
 * index and working tree are untouched; untracked files count (respecting .gitignore).
 */
export const CHANGESET_SCRIPT = String.raw`set -euo pipefail
cd -- "$1" 2>/dev/null || { echo "ERR no such directory: $1"; exit 3; }
base="$2"
gd=$(git rev-parse --git-dir 2>/dev/null) || { echo "ERR not a git repository: $1"; exit 3; }
mb=$(git merge-base HEAD "origin/$base" 2>/dev/null) || { echo "ERR origin/$base not found here; run: git fetch origin $base"; exit 3; }
idx=$(mktemp); trap 'rm -f "$idx"' EXIT
cp "$gd/index" "$idx" 2>/dev/null || rm -f "$idx"
export GIT_INDEX_FILE="$idx"
git add -A
echo "BASE $mb"
git diff --cached --no-renames --raw -z "$mb" | while IFS= read -r -d '' meta && IFS= read -r -d '' path; do
  read -r _old newmode _osha nsha status <<<"$meta"
  p=$(printf '%s' "$path" | base64 -w0)
  if [ "$status" = D ]; then echo "D - $p -"; continue; fi
  if [ "$newmode" = 160000 ]; then echo "ERR submodules are not supported: $path"; exit 4; fi
  c=$(git cat-file blob "$nsha" | base64 -w0)
  [ -n "$c" ] || c=-
  echo "$status $newmode $p $c"
done
`;

/** Parses CHANGESET_SCRIPT output, enforcing the caps. */
export function parseChangeSet(stdout: string): ChangeSet {
  const lines = stdout.split("\n").filter(Boolean);
  const err = lines.find((l) => l.startsWith("ERR "));
  if (err) throw new ApiError(400, `github_create_pr: ${err.slice(4)}`, "github_changeset");
  const head = /^BASE ([0-9a-f]{40,64})$/.exec(lines[0] ?? "");
  if (!head) throw new ApiError(502, "github_create_pr: could not read the change set");
  const files: ChangedFile[] = [];
  let total = 0;
  for (const line of lines.slice(1)) {
    const [status, mode, p64, c64] = line.split(" ");
    if (!status || !mode || !p64 || !c64 || !["A", "M", "D", "T"].includes(status))
      throw new ApiError(502, "github_create_pr: unreadable change set line");
    const path = Buffer.from(p64, "base64").toString("utf8");
    if (!path || path.startsWith("/") || path.split("/").includes(".."))
      throw new ApiError(400, `github_create_pr: refusing path ${JSON.stringify(path)}`);
    if (/^\.github\/workflows\//.test(path))
      throw new ApiError(
        403,
        "github_create_pr: changes to .github/workflows are not allowed (the App has no workflow permission)",
        "github_workflow_change",
      );
    if (status === "D") {
      files.push({ path, status: "D", mode: "100644" });
      continue;
    }
    if (!["100644", "100755", "120000"].includes(mode))
      throw new ApiError(400, `github_create_pr: unsupported file mode ${mode} for ${path}`);
    const content = c64 === "-" ? "" : c64;
    const bytes = Math.floor((content.length * 3) / 4);
    if (bytes > CHANGE_LIMITS.fileBytes)
      throw new ApiError(413, `github_create_pr: ${path} is larger than 1 MiB`);
    total += bytes;
    files.push({
      path,
      status: status as ChangedFile["status"],
      mode: mode as ChangedFile["mode"],
      content,
    });
  }
  if (files.length > CHANGE_LIMITS.files)
    throw new ApiError(413, `github_create_pr: more than ${CHANGE_LIMITS.files} changed files`);
  if (total > CHANGE_LIMITS.totalBytes)
    throw new ApiError(413, "github_create_pr: the change set is larger than 8 MiB");
  if (!files.length)
    throw new ApiError(400, "github_create_pr: no changes against the base branch");
  return { base: head[1]!, files };
}

/**
 * Well-known credential formats (the egress proxy's SECRET_PATTERNS). A change set carrying one
 * is refused before anything leaves; the error names the file and the rule, never the value.
 */
export const SECRET_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["openai-style-key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["private-key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];

export function scanChangeSet(changes: ChangeSet): void {
  for (const f of changes.files) {
    const text = `${f.path}\n${f.content ? Buffer.from(f.content, "base64").toString("latin1") : ""}`;
    for (const [name, pattern] of SECRET_PATTERNS)
      if (pattern.test(text))
        throw new ApiError(
          422,
          `github_create_pr: ${f.path} looks like it contains a credential (${name}); remove it and try again`,
          "github_secret_in_changes",
        );
  }
}

/** `Co-authored-by: <display name> <login email>`, or undefined without a usable email. */
export function coAuthorTrailer(who: { name?: string | null; email?: string | null } | undefined) {
  const email = who?.email?.trim() ?? "";
  if (!/^[^\s<>@,]+@[^\s<>@,]+$/.test(email)) return undefined;
  const name =
    (who?.name ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) ||
    email.split("@")[0]!;
  return `Co-authored-by: ${name} <${email}>`;
}

/** `linguini/<slug>-<exec suffix>`: the only branch shape the tool ever writes. */
export function publishBranch(requested: string, execId: string) {
  const slug =
    requested
      .toLowerCase()
      .replace(/^linguini\//, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .replace(/\.{2,}/g, ".")
      .slice(0, 50) || "change";
  return `linguini/${slug}-${execId
    .replace(/[^a-z0-9]/gi, "")
    .slice(-8)
    .toLowerCase()}`;
}

export function githubCreatePrTool(o: {
  config: PublishConfig;
  publisher: GitHubPublisher;
  /** Runs the change-set script in the conversation's sandbox. */
  readChanges(run: HostToolRun, dir: string, base: string): Promise<string>;
  /** The owner's display name and login email (the co-author line), from the auth store. */
  identityOf?(owner: string): Promise<{ name?: string | null; email?: string | null } | undefined>;
}): HostTool {
  const repoOf = (args: Record<string, unknown>) =>
    typeof args.repo === "string" ? args.repo.trim().toLowerCase() : "";
  return {
    policy: { replay: "non-idempotent", destination: "publication", egress: true },
    writes: ["github"],
    destinations: (call) => [
      { kind: "github", target: `${repoOf(call.args)}@linguini/*`, crossesBoundary: true },
    ],
    permit: (d) => o.config.repos.has(d.target.split("@")[0]!),
    description:
      "Open a GitHub pull request from your changes in the sandbox repository. The Linguini app commits the changes " +
      "(added, modified and deleted files against origin/<base>) to a new linguini/… branch and opens the PR. Only " +
      "private repositories this server allows; never public repositories, .github/workflows or credentials.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name, e.g. acme/app" },
        title: { type: "string" },
        body: { type: "string" },
        base: { type: "string", description: "Base branch (default: the repo's default branch)" },
        branch: { type: "string", description: "Branch name hint; always becomes linguini/…" },
        path: {
          type: "string",
          description: "Repository directory in the sandbox (default /workspace/<name>)",
        },
      },
      required: ["repo", "title"],
    },
    async handler(call, run) {
      const repo = repoOf(call.args);
      const title = String(call.args.title ?? "").trim();
      if (!REPO.test(repo) || !title || title.length > 256)
        throw new ApiError(400, "github_create_pr needs repo (owner/name) and a title");
      const body = String(call.args.body ?? "").slice(0, 60_000);
      const signal = run.signal;
      const token = `Bearer ${await o.publisher.token(repo, signal)}`;
      const gh = o.publisher;
      const info = await gh.request("GET", `/repos/${repo}`, token, undefined, signal);
      if (info.status !== 200) throw new ApiError(404, `Repository ${repo} not found`);
      // Anything GitHub does not report as private counts as public and is refused.
      if (info.data.private !== true || info.data.visibility === "public")
        throw new ApiError(
          403,
          `github_create_pr: ${repo} is public; Linguini only publishes to private repositories`,
          "github_public_repo",
        );
      const base = String(call.args.base ?? info.data.default_branch ?? "main");
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(base) || base.includes(".."))
        throw new ApiError(400, "github_create_pr: invalid base branch");
      const branch = publishBranch(String(call.args.branch ?? title), run.execId);
      const [owner] = repo.split("/");
      // Retry of this execution: return the PR it already opened.
      const existing = await gh.request(
        "GET",
        `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
        token,
        undefined,
        signal,
      );
      if (existing.status === 200 && Array.isArray(existing.data) && existing.data[0])
        return { text: `Pull request already open: ${existing.data[0].html_url}` };
      const dir = String(call.args.path ?? `/workspace/${repo.split("/")[1]}`);
      if (!dir.startsWith("/workspace/") || dir.includes(".."))
        throw new ApiError(400, "github_create_pr: path must be under /workspace");
      const changes = parseChangeSet(await o.readChanges(run, dir, base));
      scanChangeSet(changes);
      const baseCommit = await gh.request(
        "GET",
        `/repos/${repo}/git/commits/${changes.base}`,
        token,
        undefined,
        signal,
      );
      if (baseCommit.status !== 200)
        throw new ApiError(
          409,
          `github_create_pr: base commit ${changes.base.slice(0, 12)} is not on GitHub; fetch and rebase first`,
        );
      const tree = [];
      for (const f of changes.files) {
        if (f.status === "D") {
          tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
          continue;
        }
        const blob = await gh.request(
          "POST",
          `/repos/${repo}/git/blobs`,
          token,
          { content: f.content, encoding: "base64" },
          signal,
        );
        if (blob.status !== 201) throw new ApiError(502, `Could not upload ${f.path}`);
        tree.push({ path: f.path, mode: f.mode, type: "blob", sha: blob.data.sha });
      }
      const t = await gh.request(
        "POST",
        `/repos/${repo}/git/trees`,
        token,
        { base_tree: baseCommit.data.tree.sha, tree },
        signal,
      );
      if (t.status !== 201) throw new ApiError(502, "Could not create the tree");
      const trailer = coAuthorTrailer(await o.identityOf?.(run.owner));
      const message = `${body ? `${title}\n\n${body}` : title}${trailer ? `\n\n${trailer}` : ""}`;
      const commit = await gh.request(
        "POST",
        `/repos/${repo}/git/commits`,
        token,
        {
          message,
          tree: t.data.sha,
          parents: [changes.base],
        },
        signal,
      );
      if (commit.status !== 201) throw new ApiError(502, "Could not create the commit");
      const ref = await gh.request(
        "POST",
        `/repos/${repo}/git/refs`,
        token,
        { ref: `refs/heads/${branch}`, sha: commit.data.sha },
        signal,
      );
      if (ref.status !== 201) throw new ApiError(502, `Could not create branch ${branch}`);
      const pr = await gh.request(
        "POST",
        `/repos/${repo}/pulls`,
        token,
        { title, body, head: branch, base },
        signal,
      );
      if (pr.status !== 201) throw new ApiError(502, "Could not open the pull request");
      return {
        text:
          `Opened ${pr.data.html_url} (${changes.files.length} file${changes.files.length === 1 ? "" : "s"}, branch ${branch}).` +
          (trailer ? ` The commit credits you (${trailer.slice(16)}).` : ""),
      };
    },
  };
}
