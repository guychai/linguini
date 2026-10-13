import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { workerId } from "./worker-id.ts";
import { PostgresStore } from "./store.ts";
import { FixtureSandbox, RemoteSandbox, SandboxBroker } from "./sandbox.ts";
import {
  CommandNetworkProvisioner,
  FileEgressPolicyWriter,
  HandsSandbox,
  NomadHttpApi,
  NomadKataHands,
  NomadCliTransport,
  HandsJobTemplate,
  type EgressRule,
} from "./hands.ts";
import { FixtureHarness, PiHarness } from "./harness.ts";
import { sandboxSystemPrompt } from "./sandbox-prompt.ts";
import { Engine } from "./engine.ts";
import { IdleReaper, StopOnIdle, parseDuration } from "./idle.ts";
import { api, type TokenBindings } from "./api.ts";
import { TerminalManager } from "./terminal.ts";
import { SandboxFiles, recordUserEdit } from "./files.ts";
import { NomadExecConnector } from "./nomad-exec.ts";
import { NomadStreamExec, S3SandboxSuspender, S3SnapshotStore } from "./persistence.ts";
import { S3Client } from "./s3.ts";
import {
  PostgresPreviewPorts,
  PreviewActivity,
  PreviewProxy,
  PREVIEW_INSTALL_SCRIPT,
  previewEnvFile,
  previewToolHandler,
} from "./preview.ts";
import { append } from "./store.ts";
import { ConversationDeleter } from "./deletion.ts";
import { AccountAdmin } from "./accounts.ts";
import { sandboxQuota, type HandsBinding } from "./hands.ts";
import { PostgresSettings, effectiveModel, settingsPolicyFromEnv } from "./users.ts";
import { authConfigFromEnv, createAuth } from "./auth.ts";
import { createHmac } from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL for an owned prototype database");
const bindings: TokenBindings = JSON.parse(
  process.env.OWNER_TOKENS ??
    (await readFile(process.env.OWN_AUTH_FILE ?? "../../.t3/own/auth.json", "utf8")),
);
if (
  Object.values(bindings).some((owner) => typeof owner !== "string" || !owner || owner.length > 100)
)
  throw new Error("Invalid owner bindings");
const store = await PostgresStore.open(url);
// AUTH_MODE=better-auth: email/password accounts and session cookies (auth.ts); Better Auth's
// tables live in this database next to the conversations.
const authMode = process.env.AUTH_MODE === "better-auth";
const authPool = authMode
  ? new (await import("pg")).default.Pool({ connectionString: url, max: 4 })
  : undefined;
const auth = authPool ? await createAuth(authConfigFromEnv(process.env, authPool)) : undefined;
const users = authPool ? await PostgresSettings.open(authPool) : undefined;
const settingsPolicy = settingsPolicyFromEnv();
// Preview grants (preview.ts) are signed with a key derived from the auth secret.
const previewGrantKey = auth
  ? createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update("linguini-preview-grant").digest()
  : undefined;
const egressRules: Record<string, EgressRule[]> = process.env.EGRESS_RULES_FILE
  ? JSON.parse(await readFile(process.env.EGRESS_RULES_FILE, "utf8"))
  : {};
// Default: the deterministic fixture. "nomad-kata" is opt-in and needs a Nomad agent with the
// kit's agent.hcl (infra/sandbox-kit); exec has no transport yet, so tools answer 501 there.
// Hands jobs are submitted only with the egress boundary configured: EGRESS_POLICY_DIR (policy
// files the proxy reads) and EGRESS_CA_FILE (node CA certificate). Each conversation's network is
// created through SANDBOX_NETCTL (default: sudo -n /opt/sandbox-egress/node/sandbox-netctl).
// Without them NomadKataHands refuses to submit anything.
const egressWriter = process.env.EGRESS_POLICY_DIR
  ? new FileEgressPolicyWriter(process.env.EGRESS_POLICY_DIR)
  : undefined;
// Node-wide default allowlist (e.g. package registries), applied to every conversation before
// the owner's own rules. Trusted server config only.
const defaultEgressRules: EgressRule[] = process.env.EGRESS_DEFAULT_RULES_FILE
  ? JSON.parse(await readFile(process.env.EGRESS_DEFAULT_RULES_FILE, "utf8"))
  : [];
const rulesFor = (owner: string) => [...defaultEgressRules, ...(egressRules[owner] ?? [])];
const sandboxNetwork =
  egressWriter && process.env.EGRESS_CA_FILE
    ? new CommandNetworkProvisioner(
        process.env.SANDBOX_NETCTL ? JSON.parse(process.env.SANDBOX_NETCTL) : undefined,
      )
    : undefined;
const nomadApi = new NomadHttpApi(process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646");
const sandboxPlacement =
  egressWriter && process.env.EGRESS_CA_FILE
    ? {
        network: sandboxNetwork!,
        egress: {
          writer: egressWriter,
          rules: rulesFor,
          caPem: await readFile(process.env.EGRESS_CA_FILE, "utf8"),
        },
      }
    : undefined;
let kataHands: NomadKataHands | undefined;
const handsTransport = new NomadCliTransport(process.env.NOMAD_BIN ?? "nomad", {
  NOMAD_ADDR: process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646",
});
// Preview ports (PREVIEW_PUBLIC_ORIGIN, e.g. https://<service>.<tailnet>.ts.net): /preview/<id>/<port>/
// forwards into the conversation's own sandbox, only to ports it shared.
const previewOrigin = process.env.PREVIEW_PUBLIC_ORIGIN?.replace(/\/+$/, "");
if (previewOrigin && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(previewOrigin))
  throw new Error("PREVIEW_PUBLIC_ORIGIN must be an origin like https://host");
const previewPorts =
  previewOrigin && process.env.SANDBOX_PROVIDER === "nomad-kata"
    ? await PostgresPreviewPorts.open(url)
    : undefined;
const previewBase = (id: string) => `${previewOrigin}/preview/${id}`;
const previewActivity = new PreviewActivity();
const previewTools = previewPorts
  ? previewToolHandler({
      ports: previewPorts,
      baseUrl: previewBase,
      record: async (o, i, type, data) => {
        await store.mutate(o, i, (c) => void append(c, type, data));
      },
    })
  : undefined;
/** Keep the sandbox's preview env file and preview-url helper current (no ledger: not a tool). */
const installPreviewEnv = async (owner: string, id: string, b: HandsBinding) => {
  if (!previewPorts || !b.allocId) return;
  const ports = (await previewPorts.list(owner, id)).map((p) => p.port);
  const r = await handsTransport.exec(b, {
    execId: `preview-env-${b.jobId}-${Date.now()}`,
    epoch: 0,
    callId: "preview-env",
    argv: ["sh", "-c", PREVIEW_INSTALL_SCRIPT],
    stdin: previewEnvFile(previewBase(id), ports),
    deadlineMs: 30_000,
    outputLimitBytes: 4096,
  });
  if (r.exitCode !== 0) console.log(`preview env install failed (${id}): exit ${r.exitCode}`);
};
// Workspace persistence (SANDBOX_PERSISTENCE=s3): snapshot on idle stop, restore on next start.
// Anything else keeps StopOnIdle (workspace lost on stop).
let persistence: S3SandboxSuspender | undefined;
let snapshotBucket: S3Client | undefined;
if (process.env.SANDBOX_PERSISTENCE === "s3" && process.env.SANDBOX_PROVIDER === "nomad-kata") {
  const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY)
    throw new Error(
      "SANDBOX_PERSISTENCE=s3 needs S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY",
    );
  const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    bucket: S3_BUCKET ?? "linguini-sandboxes",
    region: process.env.S3_REGION,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  });
  // Storage down at boot must not take the platform down: fall back to StopOnIdle (logged).
  let bucketOk = false;
  for (let i = 0; i < 10 && !bucketOk; i++)
    bucketOk = await s3.ensureBucket().then(
      () => true,
      async (e) => {
        console.log(`sandbox persistence: S3 not ready (${e instanceof Error ? e.message : e})`);
        await new Promise((r) => setTimeout(r, 3000));
        return false;
      },
    );
  if (bucketOk) snapshotBucket = s3;
  if (bucketOk)
    persistence = new S3SandboxSuspender(
      {
        claimIdle: (o, i, ms) => kataHands!.claimIdle(o, i, ms),
        unclaimIdle: (o, i, g) => kataHands!.unclaimIdle(o, i, g),
        stop: (o, i) => kataHands!.stop(o, i),
      },
      store,
      new S3SnapshotStore(s3),
      new NomadStreamExec(process.env.NOMAD_BIN ?? "nomad", {
        NOMAD_ADDR: process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646",
      }),
      {
        maxBytes: Number(process.env.SNAPSHOT_MAX_BYTES) || undefined,
        log: (m) => console.log(m),
      },
    );
  console.log(
    persistence
      ? `sandbox persistence: s3 bucket ${S3_BUCKET ?? "linguini-sandboxes"}`
      : "sandbox persistence: DISABLED (S3 unreachable at startup); idle stop loses files",
  );
}
const provider =
  process.env.SANDBOX_PROVIDER === "remote"
    ? new RemoteSandbox(process.env.SANDBOX_URL ?? "", process.env.SANDBOX_TOKEN ?? "")
    : process.env.SANDBOX_PROVIDER === "nomad-kata"
      ? new HandsSandbox(
          (kataHands = new NomadKataHands(store, nomadApi, {
            sandbox: sandboxPlacement,
            template: HandsJobTemplate.load().withResources({
              memoryMB: Number(process.env.SANDBOX_MEMORY_MB) || undefined,
              cpuMHz: Number(process.env.SANDBOX_CPU_MHZ) || undefined,
              dockerTmpfsMB: Number(process.env.SANDBOX_DOCKER_TMPFS_MB) || undefined,
            }),
            afterReady: async (o: string, i: string, b: HandsBinding) => {
              if (persistence) await persistence.restore(o, i, b);
              await installPreviewEnv(o, i, b).catch((e) =>
                console.log(
                  `preview env install failed (${i}): ${e instanceof Error ? e.message : e}`,
                ),
              );
            },
            // A snapshot upload can outlast the default 30 s wait for an in-flight stop.
            ...(persistence ? { stoppingWaitMs: 15 * 60_000 } : {}),
            transport: handsTransport,
            // Per-user running-sandbox cap; the cluster's own capacity still applies on top.
            admit: sandboxQuota(store, Number(process.env.MAX_SANDBOXES_PER_USER ?? 3)),
          })),
          // The egress proxy is the boundary only when the server writes its policy files.
          // Rules come from trusted server config (owner -> rules), never from requests.
          {
            ...(egressWriter ? { egress: egressWriter, egressRules: rulesFor } : {}),
            ...(previewTools ? { previewTools } : {}),
          },
        )
      : new FixtureSandbox();
const broker = new SandboxBroker(store, provider);
// Model-facing description of the sandbox; allowed hosts come from the node's default rules.
const systemPrompt = sandboxSystemPrompt(defaultEgressRules);
const livePi = process.env.HARNESS_MODE === "pi";
const hostDir = resolve(process.env.PI_HOST_DIR ?? "../../.t3/own/host-control");
// Several workers may share one database: each conversation is owned through a
// renewable lease with a monotonic epoch, and every write is fenced by it.
const leaseMs = Number(process.env.OWN_LEASE_MS ?? 30_000);
const engine = new Engine(
  store,
  async (owner, id, jobId, fence) =>
    livePi
      ? PiHarness.create(
          broker,
          owner,
          id,
          hostDir,
          jobId,
          fence,
          systemPrompt,
          users ? effectiveModel(await users.settings(owner), settingsPolicy) : {},
        )
      : new FixtureHarness(broker, owner, id, jobId, fence),
  // Unique per process by default (hostname:port:<random>); see worker-id.ts.
  {
    worker: workerId(),
    leaseMs,
    // Tool-ledger recovery after each new lease: interrupted safe reads and idempotent writes.
    recoverTools: (owner, id, fence) => broker.recover(owner, id, fence),
  },
);
// Every owner with data: token owners, the tailnet owner, and (multi-user) everyone who has a
// conversation. Recovery, the lease sweeper and the idle reaper walk this set.
const owners = new Set(Object.values(bindings));
if (process.env.AUTH_MODE === "tailnet") owners.add(process.env.TAILNET_OWNER ?? "local-owner");
const refreshOwners = async () => {
  for (const r of await store.refs()) if (!r.deletedAt) owners.add(r.owner);
};
await refreshOwners();
for (const owner of owners) await engine.recover(owner);
// Pick up conversations whose previous owner crashed and let its lease expire.
const sweeper = setInterval(() => {
  void refreshOwners()
    .catch(() => undefined)
    .then(() => {
      for (const owner of owners) void engine.sweep(owner).catch(() => undefined);
    });
}, leaseMs);
const idleMs = parseDuration(process.env.SANDBOX_IDLE_TIMEOUT);
// User terminals run inside the conversation's Kata sandbox (Nomad exec TTY). User-only: Pi has
// no access and terminal use does not taint; logs carry open/close and byte counts only.
const terminals =
  provider instanceof HandsSandbox
    ? new TerminalManager({
        prepare: async (owner, id) => {
          const c = await store.snapshot(owner, id, { events: false });
          return provider.prepareInteractive(owner, id, c.tainted === true);
        },
        connector: new NomadExecConnector(process.env.NOMAD_ADDR ?? "http://127.0.0.1:4646"),
        perConversation: Number(process.env.TERMINALS_PER_CONVERSATION) || 4,
        perNode: Number(process.env.TERMINALS_PER_NODE) || 16,
        log: (m) => console.log(m),
      })
    : undefined;
// Files panel: read-only, user-only browsing of the sandbox /workspace (files.ts). Browsing
// starts a stopped sandbox like the terminal and counts as activity for the idle reaper.
const fileActivity = new PreviewActivity();
const files =
  provider instanceof HandsSandbox && kataHands
    ? new SandboxFiles({
        prepare: async (owner, id) => {
          const c = await store.snapshot(owner, id, { events: false });
          return provider.prepareInteractive(owner, id, c.tainted === true);
        },
        exec: (owner, id, request) => kataHands!.exec(owner, id, request),
        touch: (owner, id) => fileActivity.touch(owner, id),
        // Remembered for Pi's next turn (engine prepends a note); not a tool call, not ledgered.
        onWrite: (owner, id, path) =>
          store.mutate(owner, id, (c) => {
            c.userEdits = recordUserEdit(c.userEdits, path);
          }),
      })
    : undefined;
const terminalCapMs = parseDuration(process.env.TERMINAL_KEEPALIVE_CAP ?? "2h");
const reaper =
  kataHands && idleMs > 0
    ? new IdleReaper(
        store,
        () => owners,
        persistence ?? new StopOnIdle(kataHands),
        idleMs,
        (m) => console.log(m),
        {
          keepAlive: (owner, id, last) =>
            (terminals?.keepsAlive(owner, id, last, idleMs, terminalCapMs) ?? false) ||
            previewActivity.keepsAlive(owner, id, last, idleMs, terminalCapMs) ||
            fileActivity.keepsAlive(owner, id, last, idleMs, terminalCapMs),
          onSuspended: (owner, id) => terminals?.sandboxStopped(owner, id),
        },
      ).start()
    : undefined;
// Conversation deletion: compute (no snapshot), network, policy file, snapshots, then rows.
// Only targets this node actually uses are wired; the sweeper retries and removes orphans.
const deleter = new ConversationDeleter(
  store,
  {
    ...(kataHands ? { nomad: nomadApi } : {}),
    ...(kataHands && sandboxNetwork ? { network: sandboxNetwork } : {}),
    ...(egressWriter ? { policies: egressWriter } : {}),
    ...(snapshotBucket ? { snapshots: snapshotBucket } : {}),
    local: async (owner, id) => {
      await engine.forget(owner, id);
      terminals?.close(owner, id);
      previewActivity.forget(owner, id);
      fileActivity.forget(owner, id);
    },
  },
  {
    log: (m) => console.log(m),
    // Orphan removal is opt-in (DELETION_ORPHANS=delete); by default candidates are only logged.
    orphanDryRun: process.env.DELETION_ORPHANS !== "delete",
  },
).start(Number(process.env.DELETION_SWEEP_MS) || 10 * 60_000);
const { server, closeStreams } = api(
  engine,
  bindings,
  process.env.OWN_WEB_DIST ? resolve(process.env.OWN_WEB_DIST) : undefined,
  {
    ...(auth && users
      ? {
          auth: {
            auth,
            settings: users,
            policy: settingsPolicy,
            accounts: new AccountAdmin(auth.admin, store, deleter, users, (m) => console.log(m)),
            onUser: (u: { id: string }) => owners.add(u.id),
          },
        }
      : {}),
    deleter,
    terminals,
    ...(files ? { files } : {}),
    ...(previewPorts && previewTools && kataHands
      ? {
          previews: {
            ports: previewPorts,
            baseUrl: previewBase,
            proxy: (resolveOwner) =>
              new PreviewProxy({
                ports: previewPorts,
                targets: { address: (o, i) => kataHands!.address(o, i) },
                activity: previewActivity,
                conversationExists: async (o, i) =>
                  void (await store.snapshot(o, i, { events: false })),
                resolveOwner,
                ...(previewGrantKey ? { grantKey: previewGrantKey } : {}),
              }),
            // The user's toggle in the UI: same record as the agent's tool, env file refreshed
            // if the sandbox is running (otherwise on its next start).
            share: async (o, i, args, tool) => {
              const out = await previewTools(o, i, { tool, args });
              const b = (await store.snapshot(o, i, { events: false })).hands;
              if (b?.state === "ready") await installPreviewEnv(o, i, b).catch(() => undefined);
              return out.text;
            },
          },
        }
      : {}),
  },
);
server.listen(Number(process.env.OWN_PORT ?? 43220), process.env.OWN_HOST ?? "127.0.0.1", () =>
  console.log(
    `Owned backend ready (${livePi ? "live host Pi" : "deterministic harness fixture"}, ${provider.kind}, Postgres)`,
  ),
);
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  closeStreams();
  terminals?.closeAll();
  server.close();
  clearInterval(sweeper);
  reaper?.stop();
  deleter.stop();
  await engine.stop();
  await store.close();
};
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
