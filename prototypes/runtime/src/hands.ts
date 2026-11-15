/**
 * Hands: the per-conversation compute that runs tools (handoff section 10). The broker owns the
 * binding; the agent never names a runtime, image, mount or privilege.
 *
 * - Lazy: nothing is allocated until a tool first needs hands.
 * - Idempotent per (principal, conversation, generation): the Nomad job ID is derived from them
 *   and registered create-only (EnforceIndex, JobModifyIndex 0), and the binding is claimed
 *   under the conversation row lock, so racing first calls (in one process or several) produce
 *   one job and one binding.
 * - Persisted state: requested -> allocating -> ready | failed; stopping -> stopped.
 * - No host fallback: a failed or missing allocation is a real error; nothing runs locally.
 * - Execution ID and lease epoch travel with every exec; a stale generation is refused.
 * - Workspace lifetime is separate from compute lifetime: `workspaceId` is stable per
 *   (principal, conversation) and survives generations; each generation is a new compute job.
 *   Durable workspace contents: optional, via afterReady + claimIdle (src/persistence.ts).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ApiError,
  append,
  assertFence,
  type Conversation,
  type Fence,
  type Store,
} from "./store.ts";
import { PREVIEW_INSTALL_SCRIPT } from "./preview.ts";
import {
  globMatcher,
  sandboxPath,
  type ExecuteOptions,
  type SandboxProvider,
  type ToolCall,
  type ToolResult,
} from "./sandbox.ts";

export type HandsState = "requested" | "allocating" | "ready" | "failed" | "stopping" | "stopped";
export const HANDS_TEMPLATE = "hands-kata-dind/v1";
export interface HandsBinding {
  /** Stable for (principal, conversation): the workspace outlives any one compute generation. */
  workspaceId: string;
  /** Compute generation; replacing compute increments it and derives a new job ID. */
  generation: number;
  state: HandsState;
  jobId: string;
  allocId?: string;
  template: string;
  image: string;
  runtime: string;
  /** Lease epoch of the worker that requested this generation. */
  requestedEpoch: number;
  updatedAt: string;
  error?: string;
}
export interface HandsExecRequest {
  /** Durable execution ID from the tool ledger: the hands side must not apply it twice. */
  execId: string;
  epoch: number;
  callId: string;
  /** argv, run directly in the sandbox (no host shell). */
  argv: string[];
  /** Bytes for the command's stdin (file contents for write/edit). */
  stdin?: string;
  /** The binding generation the caller believes is current; a mismatch is refused. */
  generation?: number;
  deadlineMs: number;
  outputLimitBytes: number;
}
export interface HandsExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export interface HandsProvider {
  /** Lazily allocate (or join an allocation in flight) and wait until ready. Idempotent. */
  ensure(owner: string, conversationId: string, fence?: Fence): Promise<HandsBinding>;
  /** Run one command in the conversation's hands. Never runs on the host. */
  exec(
    owner: string,
    conversationId: string,
    request: HandsExecRequest,
    fence?: Fence,
  ): Promise<HandsExecResult>;
  /** Stop compute (the workspace record stays). Idempotent. */
  stop(owner: string, conversationId: string, fence?: Fence): Promise<HandsBinding | null>;
  /** After a restart: converge the persisted binding with the scheduler's actual state. */
  reconcile(owner: string, conversationId: string, fence?: Fence): Promise<HandsBinding | null>;
}

// ---- Nomad HTTP API (only the endpoints the provider uses) ----
export interface NomadAllocation {
  ID: string;
  ClientStatus: string;
  DesiredStatus: string;
  TaskStates?: Record<
    string,
    {
      State: string;
      Failed: boolean;
      Restarts?: number;
      Events?: Array<{ Type: string; DisplayMessage?: string }>;
    }
  >;
}
export interface NomadEvaluation {
  ID: string;
  Status: string;
  FailedTGAllocs?: Record<string, unknown> | null;
  BlockedEval?: string;
}
export interface NomadApi {
  /** Create-only registration. Resolves "created" or "exists"; anything else throws. */
  registerNew(job: Record<string, unknown>): Promise<"created" | "exists">;
  /** null when the job does not exist. */
  job(jobId: string): Promise<Record<string, unknown> | null>;
  allocations(jobId: string): Promise<NomadAllocation[]>;
  evaluations(jobId: string): Promise<NomadEvaluation[]>;
  /** Stop and purge; resolves even if the job is already gone. */
  purge(jobId: string): Promise<void>;
  /** Job IDs starting with `prefix` (deletion sweeper). */
  jobIds?(prefix: string): Promise<string[]>;
}
export class NomadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Minimal client for Nomad's HTTP API (verified against Nomad 2.0.7). No ACL token support yet. */
export class NomadHttpApi implements NomadApi {
  constructor(
    private readonly addr: string,
    private readonly timeoutMs = 15_000,
  ) {}
  private async call(method: string, route: string, body?: unknown) {
    const response = await fetch(new URL(route, this.addr), {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new NomadError(response.status, text.trim().slice(0, 500));
    return text ? (JSON.parse(text) as unknown) : null;
  }
  async registerNew(job: Record<string, unknown>) {
    assertKataJob(job);
    try {
      await this.call("POST", "/v1/jobs", { Job: job, EnforceIndex: true, JobModifyIndex: 0 });
      return "created" as const;
    } catch (error) {
      // Nomad answers a create-only conflict with HTTP 500 "Enforcing job modify index 0: job already exists".
      if (error instanceof NomadError && /job already exists/.test(error.message))
        return "exists" as const;
      throw error;
    }
  }
  async job(jobId: string) {
    try {
      return (await this.call("GET", `/v1/job/${encodeURIComponent(jobId)}`)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if (error instanceof NomadError && error.status === 404) return null;
      throw error;
    }
  }
  async allocations(jobId: string) {
    return (await this.call(
      "GET",
      `/v1/job/${encodeURIComponent(jobId)}/allocations`,
    )) as NomadAllocation[];
  }
  async evaluations(jobId: string) {
    return (await this.call(
      "GET",
      `/v1/job/${encodeURIComponent(jobId)}/evaluations`,
    )) as NomadEvaluation[];
  }
  async jobIds(prefix: string) {
    const jobs = (await this.call(
      "GET",
      `/v1/jobs?prefix=${encodeURIComponent(prefix)}`,
    )) as Array<{ ID: string }>;
    return jobs.map((j) => j.ID).filter((id) => id.startsWith(prefix));
  }
  async purge(jobId: string) {
    try {
      await this.call("DELETE", `/v1/job/${encodeURIComponent(jobId)}?purge=true`);
    } catch (error) {
      if (!(error instanceof NomadError && error.status === 404)) throw error;
    }
  }
}

// ---- the runtime guard ----
/**
 * Refuses any job whose every task is not a Docker task with runtime "kata". Runs on every
 * submission (NomadHttpApi.registerNew and NomadKataHands), independent of the template check,
 * so a job built any other way still cannot reach Nomad without Kata. Sandbox nodes also run
 * Docker with default-runtime kata; this is the second, backend-side layer.
 */
export function assertKataJob(job: Record<string, unknown>, network?: SandboxNetwork) {
  const refuse = (why: string) =>
    new ApiError(400, `Refusing job ${String(job.ID)}: ${why}`, "hands_job_refused");
  const groups = Array.isArray(job.TaskGroups) ? (job.TaskGroups as Json[]) : [];
  const tasks = groups.flatMap((g) => (Array.isArray(g?.Tasks) ? (g.Tasks as Json[]) : []));
  if (!tasks.length) throw new ApiError(400, "Refusing job without tasks", "hands_job_refused");
  // A group network (bridge, cni/*, host) makes Nomad create a pause container and join tasks to
  // it ("container:<id>"), outside the sandbox network and its nftables binding.
  for (const g of groups)
    if (Array.isArray(g?.Networks) && g.Networks.length)
      throw refuse(`group ${String(g.Name)} must not declare a group network`);
  for (const t of tasks) {
    const config = (t?.Config ?? {}) as Json;
    if (t?.Driver !== "docker" || config.runtime !== "kata")
      throw new ApiError(
        400,
        `Refusing job ${String(job.ID)}: task ${String(t?.Name)} must use the docker driver with runtime "kata" (got ${String(t?.Driver)}/${String(config.runtime ?? "unset")})`,
        "hands_job_refused",
      );
    if (config.privileged)
      throw new ApiError(400, `Refusing privileged task ${String(t?.Name)}`, "hands_job_refused");
    // Only a per-sandbox network (forced through the egress proxy by the node's nftables), never
    // host/bridge/default/none/container:*; and, when the broker knows it, exactly this
    // conversation's network, address and DNS.
    const mode = config.network_mode;
    if (typeof mode !== "string" || !SANDBOX_NETWORK.test(mode))
      throw refuse(
        `task ${String(t?.Name)} network must be a sandbox network sbx*, got ${String(mode ?? "unset")}`,
      );
    if (network) {
      const dns = config.dns_servers;
      if (
        mode !== network.name ||
        config.ipv4_address !== network.ipv4 ||
        !Array.isArray(dns) ||
        dns.length !== 1 ||
        dns[0] !== network.gateway
      )
        throw refuse(
          `task ${String(t?.Name)} is not on this conversation's sandbox network ${network.name} (${network.ipv4}, dns ${network.gateway})`,
        );
    } else if (typeof config.ipv4_address !== "string" || !IPV4.test(config.ipv4_address))
      throw refuse(`task ${String(t?.Name)} needs a fixed sandbox ipv4_address`);
  }
}

/** Never in a sandbox: egress is transparent (node nftables redirect TCP 80/443 to the proxy). */
export const PROXY_ENV = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];
/** The guest's system CA bundle, where the entry script installs the node's egress CA. */
export const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
// ---- the per-conversation sandbox network ----
/** Per-sandbox Docker bridge network names: "sbx" + up to 12 [a-z0-9] (an interface name). */
export const SANDBOX_NETWORK = /^sbx[a-z0-9]{1,12}$/;
const IPV4 = /^10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export interface SandboxNetwork {
  /** Docker network and bridge interface name, sbx<key[0:12]>. */
  name: string;
  /** The sandbox's fixed address (bound to the bridge in nftables, mapped to the key). */
  ipv4: string;
  /** Node side of the network: transparent egress proxy (TCP 80/443 redirected) and DNS. */
  gateway: string;
}
/**
 * Creates (idempotently) the conversation's network on the node and binds it to the egress
 * boundary before any job is submitted. Implemented on the node by egress/node/sandbox-netctl.
 */
export interface SandboxNetworkProvisioner {
  ensure(conversationKey: string): Promise<SandboxNetwork>;
  release?(conversationKey: string): Promise<void>;
}
export function sandboxNetworkName(conversationKey: string) {
  return `sbx${conversationKey.slice(0, 12)}`;
}
/** Checks what a provisioner returned before it goes anywhere near a job. */
export function validateSandboxNetwork(conversationKey: string, n: unknown): SandboxNetwork {
  const v = (n ?? {}) as Record<string, unknown>;
  const octets = (ip: unknown) =>
    typeof ip === "string" && IPV4.test(ip) && ip.split(".").every((o) => Number(o) <= 255);
  if (v.name !== sandboxNetworkName(conversationKey) || !SANDBOX_NETWORK.test(String(v.name)))
    throw new Error(
      `sandbox network name ${String(v.name)} is not ${sandboxNetworkName(conversationKey)}`,
    );
  if (!octets(v.ipv4) || !octets(v.gateway) || v.ipv4 === v.gateway)
    throw new Error("sandbox network addresses invalid");
  if (
    String(v.ipv4).split(".").slice(0, 3).join(".") !==
    String(v.gateway).split(".").slice(0, 3).join(".")
  )
    throw new Error("sandbox address and gateway are not on one network");
  return { name: String(v.name), ipv4: String(v.ipv4), gateway: String(v.gateway) };
}
/**
 * Runs the node helper (default `sudo -n /opt/sandbox-egress/node/sandbox-netctl`). The backend
 * needs only that one sudoers rule, not the docker group. The key is validated before it is
 * passed, and argv is never a shell string.
 */
export class CommandNetworkProvisioner implements SandboxNetworkProvisioner {
  constructor(
    private readonly command: string[] = ["sudo", "-n", "/opt/sandbox-egress/node/sandbox-netctl"],
    private readonly timeoutMs = 60_000,
  ) {}
  private run(verb: string, key: string) {
    if (!/^[a-z0-9]{12,40}$/.test(key)) throw new Error("invalid conversation key");
    const [bin, ...pre] = this.command;
    return new Promise<string>((resolve, reject) =>
      execFile(bin!, [...pre, verb, key], { timeout: this.timeoutMs }, (error, stdout, stderr) =>
        error
          ? reject(
              new Error(
                `sandbox-netctl ${verb}: ${String(stderr || error.message)
                  .trim()
                  .slice(0, 300)}`,
              ),
            )
          : resolve(stdout),
      ),
    );
  }
  async ensure(conversationKey: string) {
    const out = await this.run("ensure", conversationKey);
    return validateSandboxNetwork(
      conversationKey,
      JSON.parse(out.trim().split("\n").at(-1) ?? "{}"),
    );
  }
  async release(conversationKey: string) {
    await this.run("release", conversationKey);
  }
}
/** Node egress settings shared by NomadKataHands (before submit) and HandsSandbox (before exec). */
export interface EgressRegistration {
  writer: EgressPolicyWriter;
  /** Trusted server-side allowlist per conversation (config, never agent input). */
  rules: (owner: string, conversationId: string) => EgressRule[];
  /** GitHub App access through the proxy (github.ts); absent: anonymous GitHub only. */
  github?: (owner: string, conversationId: string) => EgressGitHub | undefined;
  /** The node egress CA certificate (public), installed as the sandbox's trust anchor. */
  caPem: string;
}
const PEM_CERT = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?$/;
export interface SandboxPlacement {
  network: SandboxNetwork;
  caPem: string;
}

// ---- the reviewed job template ----
export const DEFAULT_TEMPLATE_PATH = fileURLToPath(
  new URL("../../../infra/sandbox-kit/nomad/hands.job.json", import.meta.url),
);
type Json = Record<string, unknown>;
const obj = (v: unknown, what: string): Json => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error(`hands template: ${what} missing`);
  return v as Json;
};
/**
 * The job rendered from infra/sandbox-kit/nomad/hands.nomad.hcl (`nomad job run -output`), loaded
 * and policy-checked once. Only ID, Name and the identity meta are replaced per conversation.
 */
export class HandsJobTemplate {
  readonly image: string;
  readonly runtime: string;
  private constructor(private readonly job: Json) {
    if (job.Meta && obj(job.Meta, "Meta").template !== HANDS_TEMPLATE)
      throw new Error(`hands template: expected ${HANDS_TEMPLATE}`);
    const groups = job.TaskGroups as unknown[];
    if (!Array.isArray(groups) || groups.length !== 1)
      throw new Error("hands template: one task group expected");
    const group = obj(groups[0], "task group");
    if (group.Count !== 1) throw new Error("hands template: Count must be 1");
    const tasks = group.Tasks as unknown[];
    if (!Array.isArray(tasks) || tasks.length !== 1)
      throw new Error("hands template: one task expected");
    const task = obj(tasks[0], "task");
    const config = obj(task.Config, "task config");
    if (task.Driver !== "docker") throw new Error("hands template: docker driver expected");
    if (config.runtime !== "kata") throw new Error("hands template: runtime must be kata");
    if (config.privileged) throw new Error("hands template: privileged is not allowed");
    if (config.volumes || config.pid_mode || config.ipc_mode)
      throw new Error("hands template: host namespaces and volumes are not allowed");
    if (typeof config.network_mode !== "string" || !SANDBOX_NETWORK.test(config.network_mode))
      throw new Error("hands template: task must be on a sandbox network (network_mode sbx*)");
    if (Array.isArray(group.Networks) && group.Networks.length)
      throw new Error("hands template: no group network (Nomad would add a pause container)");
    const templates = (task.Templates as Json[] | null) ?? [];
    if (templates.length !== 1 || templates[0]!.DestPath !== "local/egress-ca.pem")
      throw new Error("hands template: exactly one template, the egress CA at local/egress-ca.pem");
    const env = obj(task.Env, "task env");
    // Egress is transparent: a proxy variable in the guest would point tools at a closed port.
    if (PROXY_ENV.some((k) => k in env))
      throw new Error("hands template: no proxy environment (egress is transparent)");
    if (env.NODE_USE_SYSTEM_CA !== "1" || env.SSL_CERT_FILE !== SYSTEM_CA_BUNDLE)
      throw new Error("hands template: CA trust environment missing");
    const mounts = (config.mount as Json[] | undefined) ?? [];
    if (mounts.some((m) => m.type !== "tmpfs"))
      throw new Error("hands template: only tmpfs mounts are allowed");
    if (typeof config.image !== "string" || !/@sha256:[0-9a-f]{64}$/.test(config.image))
      throw new Error("hands template: image must be pinned by digest");
    const resources = obj(task.Resources, "resources");
    if (!(Number(resources.CPU) > 0 && Number(resources.MemoryMB) > 0))
      throw new Error("hands template: CPU and memory limits are required");
    this.image = config.image;
    this.runtime = config.runtime;
  }
  static load(path = DEFAULT_TEMPLATE_PATH) {
    const parsed = obj(JSON.parse(readFileSync(path, "utf8")), "file");
    return new HandsJobTemplate(obj(parsed.Job ?? parsed, "Job"));
  }
  /**
   * Per-node sizing: memory/CPU reservation (Kata sizes the guest from these; cpu_hard_limit
   * stays as in the template) and the tmpfs for the inner /var/lib/docker, which lives in guest
   * memory. Unset values keep the template's.
   */
  withResources(r: { memoryMB?: number; cpuMHz?: number; dockerTmpfsMB?: number }) {
    const job = structuredClone(this.job);
    const task = ((job.TaskGroups as Json[])[0]!.Tasks as Json[])[0]!;
    const resources = task.Resources as Json;
    const pos = (v: number | undefined) => v !== undefined && Number.isInteger(v) && v > 0;
    if (pos(r.memoryMB)) resources.MemoryMB = r.memoryMB;
    if (pos(r.cpuMHz)) resources.CPU = r.cpuMHz;
    if (pos(r.dockerTmpfsMB))
      for (const m of ((task.Config as Json).mount as Json[] | undefined) ?? [])
        if (m.type === "tmpfs" && m.target === "/var/lib/docker")
          m.tmpfs_options = [{ size: r.dockerTmpfsMB! * 1024 * 1024 }];
    return new HandsJobTemplate(job);
  }
  static fromJob(job: Json) {
    return new HandsJobTemplate(structuredClone(job));
  }
  /**
   * The job for one conversation and generation, placed on that conversation's sandbox network.
   * Every per-sandbox field (network, address, DNS, proxy env, CA) is overwritten, never merged.
   */
  render(key: string, generation: number, workspaceId: string, placement: SandboxPlacement): Json {
    if (!/^[a-z0-9]{12,40}$/.test(key) || !Number.isInteger(generation) || generation < 1)
      throw new Error("hands template: invalid key or generation");
    const network = validateSandboxNetwork(key, placement.network);
    if (!PEM_CERT.test(placement.caPem))
      throw new Error("hands template: egress CA is not one PEM certificate");
    const job = structuredClone(this.job);
    const task = ((job.TaskGroups as Json[])[0]!.Tasks as Json[])[0]!;
    const config = task.Config as Json;
    config.network_mode = network.name;
    config.ipv4_address = network.ipv4;
    config.dns_servers = [network.gateway];
    const env = task.Env as Record<string, string>;
    for (const k of PROXY_ENV) delete env[k];
    env.SANDBOX_DNS = network.gateway;
    (task.Templates as Json[])[0]!.EmbeddedTmpl = placement.caPem;
    job.ID = job.Name = handsJobId(key, generation);
    job.Meta = {
      ...obj(job.Meta ?? {}, "Meta"),
      conversation_key: key,
      generation: String(generation),
      workspace_id: workspaceId,
    };
    return job;
  }
}
/** Opaque, server-derived key: never user text, so it cannot steer the job ID. */
export function handsKey(owner: string, conversationId: string) {
  return createHash("sha256").update(`${owner}\0${conversationId}`).digest("hex").slice(0, 20);
}
export function handsJobId(key: string, generation: number) {
  return `hands-${key}-g${generation}`;
}

// ---- the provider ----
export interface NomadKataHandsOptions {
  template?: HandsJobTemplate;
  /**
   * Required to submit anything: the conversation's network is created and bound, and its
   * allowlist registered with the egress proxy, before the job is submitted. Without it (or if
   * either step fails) nothing is submitted.
   */
  sandbox?: { network: SandboxNetworkProvisioner; egress: EgressRegistration };
  /** Maximum wait for a running allocation (default 300 s: first image pull plus Kata boot). */
  allocationTimeoutMs?: number;
  pollMs?: number;
  /** Exec transport into a running allocation (Nomad alloc exec). Absent: exec is a 501. */
  transport?: HandsTransport;
  /**
   * A failed generation is retried (old job purged, next generation) by the first ensure() at
   * least this long after the failure (default 15 s), so one turn cannot hammer the scheduler and
   * a conversation is never permanently broken.
   */
  retryFailedAfterMs?: number;
  /**
   * Runs once per generation (per process) after it first reaches ready and before ensure()
   * returns it, e.g. restoring a persisted workspace snapshot. Must not throw for a failed
   * restore (record a note instead); a throw fails that ensure and is retried by the next one.
   */
  afterReady?: (owner: string, conversationId: string, binding: HandsBinding) => Promise<void>;
  /** How long ensure() waits for an in-flight stop (e.g. a snapshot upload) (default 30 s). */
  stoppingWaitMs?: number;
  /**
   * Admission before a conversation that has no running sandbox gets one (per-user quota).
   * Throws (e.g. ApiError 429 sandbox_quota) to refuse; running sandboxes are never affected.
   */
  admit?: (owner: string, conversationId: string) => Promise<void>;
  /** Test seam: aborts waiting (simulates the worker dying mid-allocation). */
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export interface HandsTransport {
  exec(
    binding: HandsBinding,
    request: HandsExecRequest,
    signal?: AbortSignal,
  ): Promise<HandsExecResult>;
}
const ACTIVE: HandsState[] = ["requested", "allocating", "ready"];
const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), {
      once: true,
    });
  });

export class NomadKataHands implements HandsProvider {
  readonly template: HandsJobTemplate;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly sleep: NonNullable<NomadKataHandsOptions["sleep"]>;
  constructor(
    private readonly store: Store,
    private readonly nomad: NomadApi,
    private readonly options: NomadKataHandsOptions = {},
  ) {
    this.template = options.template ?? HandsJobTemplate.load();
    this.timeoutMs = options.allocationTimeoutMs ?? 300_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.sleep = options.sleep ?? defaultSleep;
  }
  private transition(
    owner: string,
    id: string,
    fence: Fence | undefined,
    expect: { generation: number; from: HandsState[] },
    patch: Partial<HandsBinding> & { state: HandsState },
  ) {
    return this.store.mutate(owner, id, (c) => {
      assertFence(c, fence);
      const b = c.hands;
      // Only move our own generation forward from an expected state; never clobber a newer one.
      if (!b || b.generation !== expect.generation || !expect.from.includes(b.state))
        return b ? structuredClone(b) : null;
      // Racers converge on the same observation: applying it again is not a new event.
      if (Object.entries(patch).every(([k, v]) => b[k as keyof HandsBinding] === v))
        return structuredClone(b);
      Object.assign(b, patch, { updatedAt: new Date().toISOString() });
      if (patch.state !== "failed") delete b.error;
      append(c, "hands.state", {
        state: b.state,
        generation: b.generation,
        jobId: b.jobId,
        ...(b.allocId ? { allocId: b.allocId } : {}),
        ...(b.error ? { error: b.error } : {}),
      });
      return structuredClone(b);
    });
  }
  async ensure(owner: string, id: string, fence?: Fence): Promise<HandsBinding> {
    // An idle stop may be finishing as activity resumes: wait for it (bounded), then reallocate.
    const waits = Math.ceil((this.options.stoppingWaitMs ?? 30_000) / 500);
    for (let i = 0; i < waits && (await this.current(owner, id))?.state === "stopping"; i++)
      await this.sleep(500, this.options.signal);
    if (this.options.admit) {
      const b = await this.current(owner, id);
      if (!b || !ACTIVE.includes(b.state)) await this.options.admit(owner, id);
    }
    return this.ready(owner, id, await this.ensureBinding(owner, id, fence));
  }
  private readonly afterReadyRuns = new Map<string, Promise<void>>();
  private async ready(owner: string, id: string, b: HandsBinding) {
    const hook = this.options.afterReady;
    if (!hook || b.state !== "ready") return b;
    let run = this.afterReadyRuns.get(b.jobId);
    if (!run) {
      run = hook(owner, id, b);
      this.afterReadyRuns.set(b.jobId, run);
      run.catch(() => this.afterReadyRuns.delete(b.jobId));
      if (this.afterReadyRuns.size > 1000)
        this.afterReadyRuns.delete(this.afterReadyRuns.keys().next().value!);
    }
    await run;
    return b;
  }
  private async ensureBinding(owner: string, id: string, fence?: Fence): Promise<HandsBinding> {
    // Claim under the row lock: the first caller writes "requested"; racers join it.
    let claimed: HandsBinding & { retryOf?: string } = await this.store.mutate(owner, id, (c) => {
      assertFence(c, fence);
      const b = c.hands;
      if (b && ACTIVE.includes(b.state)) return structuredClone(b);
      if (
        b?.state === "failed" &&
        Date.now() - Date.parse(b.updatedAt) < (this.options.retryFailedAfterMs ?? 15_000)
      )
        throw new ApiError(
          503,
          `Hands allocation failed: ${b.error ?? "unknown"}`,
          "hands_allocation_failed",
        );
      if (b?.state === "stopping")
        throw new ApiError(409, "Hands are stopping; retry after stop completes", "hands_stopping");
      const key = handsKey(owner, id);
      const generation = (b?.generation ?? 0) + 1;
      c.hands = {
        workspaceId: b?.workspaceId ?? `ws-${key}`,
        generation,
        state: "requested",
        jobId: handsJobId(key, generation),
        template: HANDS_TEMPLATE,
        image: this.template.image,
        runtime: this.template.runtime,
        requestedEpoch: c.epoch ?? 0,
        updatedAt: new Date().toISOString(),
      };
      append(c, "hands.state", {
        state: "requested",
        generation,
        jobId: c.hands.jobId,
        ...(b?.state === "failed" ? { retryOf: b.jobId } : {}),
      });
      return { ...structuredClone(c.hands), retryOf: b?.state === "failed" ? b.jobId : undefined };
    });
    const { retryOf, ...binding } = claimed;
    // Best effort: a failed generation's job must not keep holding a reservation.
    if (retryOf) await this.nomad.purge(retryOf).catch(() => undefined);
    claimed = binding as HandsBinding;
    if (claimed.state === "ready") return claimed;
    return this.converge(owner, id, claimed, fence);
  }
  /** Drive one generation to ready or failed. Safe to run concurrently and after a restart. */
  private async converge(
    owner: string,
    id: string,
    binding: HandsBinding,
    fence?: Fence,
  ): Promise<HandsBinding> {
    const { generation, jobId } = binding;
    const key = jobId.slice("hands-".length, jobId.lastIndexOf("-g"));
    const fail = async (reason: string, purge: boolean) => {
      if (purge) await this.nomad.purge(jobId).catch(() => undefined);
      await this.transition(
        owner,
        id,
        fence,
        { generation, from: ["requested", "allocating", "ready"] },
        { state: "failed", error: reason },
      );
      throw new ApiError(503, `Hands allocation failed: ${reason}`, "hands_allocation_failed");
    };
    // Network first, then the allowlist registered with the proxy, then (only then) the job.
    const submit = async () => {
      const sandbox = this.options.sandbox;
      if (!sandbox)
        throw new ApiError(
          400,
          "Refusing to submit hands: no sandbox network / egress proxy configured",
          "hands_job_refused",
        );
      const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
      let network: SandboxNetwork;
      try {
        network = validateSandboxNetwork(key, await sandbox.network.ensure(key));
      } catch (error) {
        throw new ApiError(
          503,
          `Sandbox network unavailable: ${why(error)}`,
          "hands_egress_unavailable",
        );
      }
      try {
        const c = await this.store.snapshot(owner, id, { events: false });
        await sandbox.egress.writer.apply({
          version: 1,
          conversationKey: key,
          workspaceId: binding.workspaceId,
          tainted: c.tainted === true,
          rules: sandbox.egress.rules(owner, id),
          ...githubField(sandbox.egress.github?.(owner, id)),
        });
      } catch (error) {
        throw new ApiError(
          503,
          `Egress proxy registration failed: ${why(error)}`,
          "hands_egress_unavailable",
        );
      }
      const job = this.template.render(key, generation, binding.workspaceId, {
        network,
        caPem: sandbox.egress.caPem,
      });
      assertKataJob(job, network);
      await this.nomad.registerNew(job);
    };
    if (binding.state === "requested") {
      try {
        await submit();
      } catch (error) {
        if (error instanceof ApiError && error.code === "hands_job_refused")
          return fail(error.message, false);
        // Not submitted: stays "requested", so a retry or reconcile registers and submits again.
        if (error instanceof ApiError && error.code === "hands_egress_unavailable") throw error;
        // A definite refusal (4xx: invalid job, policy) fails the generation; other errors leave
        // it "requested" so a retry or reconcile can register create-only again.
        if (error instanceof NomadError && error.status >= 400 && error.status < 500)
          return fail(`job rejected by Nomad: ${error.message}`, false);
        throw new ApiError(
          503,
          `Nomad unavailable: ${error instanceof Error ? error.message : error}`,
          "hands_unavailable",
        );
      }
      await this.transition(
        owner,
        id,
        fence,
        { generation, from: ["requested"] },
        { state: "allocating" },
      );
    }
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const current = await this.current(owner, id);
      if (!current || current.generation !== generation)
        throw new ApiError(409, "Hands generation replaced", "hands_replaced");
      if (current.state === "failed")
        throw new ApiError(
          503,
          `Hands allocation failed: ${current.error}`,
          "hands_allocation_failed",
        );
      if (current.state === "stopping" || current.state === "stopped")
        throw new ApiError(409, "Hands stopped", "hands_stopped");
      const observed = await this.observe(jobId);
      if (observed.kind === "running") {
        if (current.state === "ready" && current.allocId === observed.allocId) return current;
        const ready = await this.transition(
          owner,
          id,
          fence,
          { generation, from: ["requested", "allocating", "ready"] },
          { state: "ready", allocId: observed.allocId },
        );
        if (ready?.state === "ready" && ready.generation === generation) return ready;
        continue;
      }
      if (observed.kind === "failed") return fail(observed.reason, true);
      if (observed.kind === "missing") {
        if (current.state === "requested") {
          await submit();
          continue;
        }
        return fail("job no longer exists in Nomad", false);
      }
      if (Date.now() >= deadline)
        return fail(`no running allocation within ${this.timeoutMs} ms`, true);
      await this.sleep(this.pollMs, this.options.signal);
    }
  }
  private async observe(
    jobId: string,
  ): Promise<
    | { kind: "running"; allocId: string }
    | { kind: "pending" }
    | { kind: "missing" }
    | { kind: "failed"; reason: string }
  > {
    if (!(await this.nomad.job(jobId))) return { kind: "missing" };
    const allocs = await this.nomad.allocations(jobId);
    const running = allocs.find((a) => a.ClientStatus === "running" && a.DesiredStatus === "run");
    if (running) return { kind: "running", allocId: running.ID };
    if (allocs.some((a) => a.ClientStatus === "pending" && a.DesiredStatus === "run"))
      return { kind: "pending" };
    const failed = allocs.find((a) => a.ClientStatus === "failed" || a.ClientStatus === "lost");
    if (failed) {
      const events = Object.values(failed.TaskStates ?? {}).flatMap((t) => t.Events ?? []);
      const why = events.filter((e) => /fail|error|kill/i.test(e.Type)).at(-1) ?? events.at(-1);
      return {
        kind: "failed",
        reason: `allocation ${failed.ID} ${failed.ClientStatus}${why ? `: ${why.Type}: ${why.DisplayMessage ?? ""}`.trimEnd() : ""}`,
      };
    }
    if (allocs.length === 0) {
      const evals = await this.nomad.evaluations(jobId);
      const placement = evals.find((e) => e.FailedTGAllocs && Object.keys(e.FailedTGAllocs).length);
      // A blocked eval means no node can host it now. Hands are on-demand: fail rather than queue.
      if (placement)
        return {
          kind: "failed",
          reason: `placement failed (${Object.keys(placement.FailedTGAllocs!).join(", ")})`,
        };
    }
    return { kind: "pending" };
  }
  private async current(owner: string, id: string) {
    return (await this.store.snapshot(owner, id, { events: false })).hands ?? null;
  }
  async reconcile(owner: string, id: string, fence?: Fence) {
    const b = await this.current(owner, id);
    if (!b) return null;
    if (b.state === "stopping") return this.stop(owner, id, fence);
    if (!ACTIVE.includes(b.state)) return b;
    try {
      return await this.converge(owner, id, b, fence);
    } catch (error) {
      if (error instanceof ApiError && error.code === "hands_allocation_failed")
        return this.current(owner, id);
      throw error;
    }
  }
  /**
   * Idle stop: atomically (under the row lock) moves a ready binding to "stopping" only when the
   * conversation has no queued/running turn and no activity (any journal append: prompts, tool
   * calls, results, sandbox transitions) for idleMs. Then stops it like stop(). Returns whether
   * it stopped. The workspace record stays; the next tool call allocates a new generation.
   */
  async stopIfIdle(owner: string, id: string, idleMs: number): Promise<boolean> {
    if (!(await this.claimIdle(owner, id, idleMs))) return false;
    await this.stop(owner, id);
    return true;
  }
  /**
   * The atomic half of stopIfIdle: moves an idle ready binding to "stopping" and returns it (the
   * allocation keeps running until stop()), or null. Lets a suspender snapshot before stopping.
   */
  async claimIdle(owner: string, id: string, idleMs: number): Promise<HandsBinding | null> {
    return await this.store.mutate(owner, id, (c) => {
      const b = c.hands;
      if (!b || b.state !== "ready") return null;
      if (c.jobs.some((j) => j.status === "running" || j.status === "queued")) return null;
      if (Date.now() - Date.parse(c.updatedAt ?? new Date().toISOString()) < idleMs) return null;
      Object.assign(b, { state: "stopping", updatedAt: new Date().toISOString() });
      append(c, "hands.state", {
        state: "stopping",
        generation: b.generation,
        jobId: b.jobId,
        reason: "idle",
      });
      return structuredClone(b);
    });
  }
  private readonly addresses = new Map<string, string>();
  /**
   * The sandbox's address on its own network (for preview ports), starting it if needed. Only
   * this conversation's sandbox: the key is derived from (owner, conversation), never input.
   */
  async address(owner: string, id: string): Promise<string> {
    const b = await this.ensure(owner, id);
    const cached = this.addresses.get(b.jobId);
    if (cached) return cached;
    const sandbox = this.options.sandbox;
    if (!sandbox) throw new ApiError(503, "No sandbox network configured", "hands_not_ready");
    const key = handsKey(owner, id);
    const ipv4 = validateSandboxNetwork(key, await sandbox.network.ensure(key)).ipv4;
    if (this.addresses.size > 1000) this.addresses.clear();
    this.addresses.set(b.jobId, ipv4);
    return ipv4;
  }
  /** Undo claimIdle (the snapshot failed): the same generation goes back to ready. */
  async unclaimIdle(owner: string, id: string, generation: number) {
    return this.transition(
      owner,
      id,
      undefined,
      { generation, from: ["stopping"] },
      {
        state: "ready",
      },
    );
  }
  async stop(owner: string, id: string, fence?: Fence) {
    const b = await this.current(owner, id);
    if (!b || b.state === "stopped") return b;
    await this.transition(
      owner,
      id,
      fence,
      {
        generation: b.generation,
        from: ["requested", "allocating", "ready", "failed", "stopping"],
      },
      { state: "stopping" },
    );
    await this.nomad.purge(b.jobId);
    // Best effort: Docker refuses to remove a network while the purged container is still
    // stopping. A leftover network stays bound to this conversation only and is reused by the
    // next generation's ensure.
    await this.options.sandbox?.network.release?.(handsKey(owner, id)).catch(() => undefined);
    return this.transition(
      owner,
      id,
      fence,
      { generation: b.generation, from: ["stopping"] },
      { state: "stopped" },
    );
  }
  async exec(
    owner: string,
    id: string,
    request: HandsExecRequest,
    fence?: Fence,
  ): Promise<HandsExecResult> {
    const c = await this.store.snapshot(owner, id, { events: false });
    // The write path (ledger intent) already checked the fence; this rejects an obviously stale caller early.
    assertFence(c, fence);
    if (fence && request.epoch !== fence.epoch)
      throw new ApiError(409, "Exec epoch does not match the lease", "STALE_OWNER");
    const b = c.hands;
    if (!b || b.state !== "ready" || !b.allocId)
      throw new ApiError(
        503,
        `Hands not ready (${b?.state ?? "none"}); no host fallback`,
        "hands_not_ready",
      );
    if (request.generation !== undefined && request.generation !== b.generation)
      throw new ApiError(
        409,
        `Stale hands generation ${request.generation} (current ${b.generation})`,
        "hands_replaced",
      );
    if (!this.options.transport)
      throw new ApiError(
        501,
        "Hands exec transport not configured; no host fallback",
        "hands_exec_unavailable",
      );
    return this.options.transport.exec(b, request, AbortSignal.timeout(request.deadlineMs));
  }
}

// ---- egress policy handed to the node's proxy ----
/** One allowlisted destination. Set by trusted server config, never by the agent or the guest. */
export interface EgressRule {
  /** Exact host, or "*.example.com" for subdomains only. Raw IPs never match. */
  host: string;
  /** Default [443]. */
  ports?: number[];
  /** Default ["https"]; "http" must be listed explicitly. */
  schemes?: ("https" | "http")[];
  /** Default: any method. */
  methods?: string[];
  /** Path globs ("*" one segment, "**" any); with methods, the rule admits only matching requests. */
  paths?: string[];
  /** Name of a node-side secret to inject for this host (the value never leaves the node). */
  inject?: string;
  websocket?: boolean;
  /** Keep this host reachable after production-data taint (default: no). */
  allowWhenTainted?: boolean;
}
/**
 * GitHub through the egress proxy (infra/sandbox-kit/egress/addon/github_app.py). The proxy always
 * drops the guest's own GitHub credentials and refuses git push; with `app`, reads of a repository
 * the node's GitHub App is installed on get a token the proxy mints for that one repository.
 */
export interface EgressGitHub {
  app: boolean;
}
export interface EgressPolicy {
  version: 1;
  conversationKey: string;
  workspaceId: string;
  tainted: boolean;
  rules: EgressRule[];
  /** Optional (older proxies ignore it): set by trusted server config per owner, never by agents. */
  github?: EgressGitHub;
}
/** The policy's `github` field, only when set (policies without it stay byte-identical). */
export const githubField = (github: EgressGitHub | undefined) => (github ? { github } : {});
export interface EgressPolicyWriter {
  apply(policy: EgressPolicy): Promise<void>;
}
/**
 * Writes the per-conversation policy file the egress proxy reads
 * (infra/sandbox-kit/egress, `policies/<conversationKey>.json`): atomic rename, so the proxy never
 * reads a partial file. The directory must not be reachable from any sandbox.
 */
export class FileEgressPolicyWriter implements EgressPolicyWriter {
  constructor(private readonly dir: string) {}
  async apply(policy: EgressPolicy) {
    const { writeFile, rename, mkdir } = await import("node:fs/promises");
    if (!/^[a-z0-9]{12,40}$/.test(policy.conversationKey))
      throw new Error("invalid conversation key");
    await mkdir(this.dir, { recursive: true, mode: 0o750 });
    const target = `${this.dir}/${policy.conversationKey}.json`;
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(policy), { mode: 0o640 });
    await rename(tmp, target);
  }
  /** Deletion: remove the conversation's policy file (absent: no-op). */
  async remove(conversationKey: string) {
    const { rm } = await import("node:fs/promises");
    if (!/^[a-z0-9]{12,40}$/.test(conversationKey)) throw new Error("invalid conversation key");
    await rm(`${this.dir}/${conversationKey}.json`, { force: true });
  }
  /** Keys with a policy file, and when each was last written (sweeper). */
  async keys(): Promise<Array<{ key: string; mtimeMs: number }>> {
    const { readdir, stat } = await import("node:fs/promises");
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: Array<{ key: string; mtimeMs: number }> = [];
    for (const n of names) {
      const m = /^([a-z0-9]{12,40})\.json$/.exec(n);
      if (!m) continue;
      const st = await stat(`${this.dir}/${n}`).catch(() => null);
      if (st) out.push({ key: m[1]!, mtimeMs: st.mtimeMs });
    }
    return out;
  }
}

const positiveInt = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
/** bash tool `timeout` (seconds) → exec deadline: default 120 s, at most BASH_TIMEOUT_MAX_S. */
export const BASH_TIMEOUT_MAX_S = 600;
export function bashDeadlineMs(timeout: unknown, fallbackMs = 120_000) {
  const t = positiveInt(timeout);
  return t === undefined ? fallbackMs : Math.min(t, BASH_TIMEOUT_MAX_S) * 1000;
}

// ---- broker adapter ----
/** Sandbox-side argv for a tool call. Paths are validated by the broker's own path rules. */
export function sandboxArgv(
  tool: string,
  args: Record<string, unknown>,
): { argv: string[]; stdin?: string } {
  const abs = (v: unknown, fallback?: string) => {
    const p = v === undefined && fallback !== undefined ? fallback : sandboxPath(v);
    return p === "." ? "/workspace" : `/workspace/${p}`;
  };
  switch (tool) {
    case "bash":
      if (typeof args.command !== "string") throw new ApiError(400, "command must be a string");
      // bash when the image has it, else POSIX sh. The command is one argv element, never spliced.
      return {
        argv: [
          "sh",
          "-c",
          // Preview URLs (PREVIEW_BASE_URL[_<port>]) from the env file Linguini keeps current.
          'cd /workspace && if [ -r /etc/linguini/preview.env ]; then . /etc/linguini/preview.env; fi; if command -v bash >/dev/null; then exec bash -c "$1"; else exec sh -c "$1"; fi',
          "sh",
          args.command,
        ],
      };
    case "read": {
      // A line window is cut in the sandbox, so large files are not limited by the output cap.
      const offset = positiveInt(args.offset);
      const limit = positiveInt(args.limit);
      if (offset === undefined && limit === undefined)
        return { argv: ["cat", "--", abs(args.path)] };
      const first = offset ?? 1;
      const range = limit === undefined ? `${first},$p` : `${first},${first + limit - 1}p`;
      return { argv: ["sed", "-n", range, "--", abs(args.path)] };
    }
    case "write":
      if (typeof args.content !== "string") throw new ApiError(400, "content must be a string");
      return {
        argv: ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", abs(args.path)],
        stdin: args.content,
      };
    case "ls":
      return { argv: ["ls", "-1Ap", "--", abs(args.path, ".")] };
    case "find": {
      if (typeof args.pattern !== "string" || !args.pattern)
        throw new ApiError(400, "pattern required");
      return { argv: ["find", abs(args.path, "."), "-type", "f"] };
    }
    case "grep": {
      if (typeof args.pattern !== "string" || !args.pattern)
        throw new ApiError(400, "pattern required");
      const flags = ["-rnH", args.ignoreCase ? "-i" : "", args.literal ? "-F" : "-E"].filter(
        Boolean,
      );
      const context =
        typeof args.context === "number" && args.context > 0
          ? ["-C", String(Math.min(20, Math.floor(args.context)))]
          : [];
      return {
        argv: ["grep", ...flags, ...context, "-e", args.pattern, "--", abs(args.path, ".")],
      };
    }
    default:
      throw new ApiError(403, "Tool unavailable");
  }
}

/**
 * Adapter to the broker's SandboxProvider. Every tool (bash, read, write, edit, grep, find, ls)
 * runs inside the conversation's sandbox; nothing runs on the host. Results are sandbox work
 * (`provenanceSource: "declared"`). With an egress policy writer, the provider is the proxy
 * boundary: before each call it hands the conversation's taint and trusted allowlist to the
 * node's egress proxy, which narrows egress after taint. Without one it claims no boundary, so
 * the broker keeps denying "proxied" egress after taint.
 */
export class HandsSandbox implements SandboxProvider {
  readonly kind = "remote";
  readonly provenanceSource = "declared";
  readonly egressBoundary: "proxy" | "none";
  constructor(
    private readonly hands: HandsProvider,
    private readonly options: {
      egress?: EgressPolicyWriter;
      /** Trusted server-side allowlist per conversation (config, never agent input). Use the same
       * function as NomadKataHands' `sandbox.egress.rules`. */
      egressRules?: (owner: string, conversationId: string) => EgressRule[];
      /** Same function as NomadKataHands' `sandbox.egress.github`. */
      egressGitHub?: (owner: string, conversationId: string) => EgressGitHub | undefined;
      deadlineMs?: number;
      outputLimitBytes?: number;
      /**
       * share_port / unshare_port (control plane, not a sandbox command): records the share and
       * returns the tool text plus the sandbox's new preview env file (installed by this call).
       */
      previewTools?: (
        owner: string,
        conversationId: string,
        call: ToolCall,
      ) => Promise<{ text: string; envFile: string }>;
      /**
       * html_preview / html_render (control plane: rendered by the render worker, images read
       * from this sandbox through the files API). visual.ts.
       */
      visualTools?: (owner: string, conversationId: string, call: ToolCall) => Promise<ToolResult>;
    } = {},
  ) {
    this.egressBoundary = options.egress ? "proxy" : "none";
  }
  async allocate(owner: string, conversationId: string) {
    const b = await this.hands.ensure(owner, conversationId);
    return `nomad-kata:${b.workspaceId}`;
  }
  /**
   * For the user's interactive terminal: provision the sandbox if needed and apply the
   * conversation's current egress policy (the terminal itself never taints). Returns the alloc.
   */
  async prepareInteractive(owner: string, conversationId: string, tainted: boolean) {
    const binding = await this.hands.ensure(owner, conversationId);
    if (binding.state !== "ready" || !binding.allocId)
      throw new ApiError(503, `Sandbox not ready (${binding.state})`, "hands_not_ready");
    if (this.options.egress)
      await this.options.egress.apply({
        version: 1,
        conversationKey: binding.jobId.slice("hands-".length, binding.jobId.lastIndexOf("-g")),
        workspaceId: binding.workspaceId,
        tainted,
        rules: this.options.egressRules?.(owner, conversationId) ?? [],
        ...githubField(this.options.egressGitHub?.(owner, conversationId)),
      });
    return { allocId: binding.allocId, generation: binding.generation };
  }
  async execute(
    _sandbox: string,
    call: ToolCall,
    _signal?: AbortSignal,
    options: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const { owner, conversationId, execId, epoch } = options;
    if (!owner || !conversationId || !execId || epoch === undefined)
      throw new ApiError(
        400,
        "Hands exec needs the broker's owner, conversation, execution ID and epoch",
      );
    // Re-ensure: after a worker restart or a compute replacement this converges, never falls back.
    const binding = await this.hands.ensure(owner, conversationId);
    if (this.options.egress)
      await this.options.egress.apply({
        version: 1,
        conversationKey: binding.jobId.slice("hands-".length, binding.jobId.lastIndexOf("-g")),
        workspaceId: binding.workspaceId,
        tainted: options.tainted === true,
        rules: this.options.egressRules?.(owner, conversationId) ?? [],
        ...githubField(this.options.egressGitHub?.(owner, conversationId)),
      });
    const run = (argv: string[], stdin?: string) =>
      this.hands.exec(owner, conversationId, {
        execId,
        epoch,
        callId: call.id,
        argv,
        ...(stdin === undefined ? {} : { stdin }),
        generation: binding.generation,
        deadlineMs:
          call.tool === "bash"
            ? bashDeadlineMs(call.args.timeout, this.options.deadlineMs ?? 120_000)
            : (this.options.deadlineMs ?? 120_000),
        outputLimitBytes: this.options.outputLimitBytes ?? 256 * 1024,
      });
    const args = call.args;
    if (call.tool === "html_preview" || call.tool === "html_render") {
      if (!this.options.visualTools)
        throw new ApiError(501, "Visual replies are not configured on this server");
      return this.options.visualTools(owner, conversationId, call);
    }
    if (call.tool === "share_port" || call.tool === "unshare_port") {
      if (!this.options.previewTools)
        throw new ApiError(501, "Preview ports are not configured on this server");
      const out = await this.options.previewTools(owner, conversationId, call);
      const r = await run(["sh", "-c", PREVIEW_INSTALL_SCRIPT], out.envFile);
      return {
        text:
          r.exitCode === 0
            ? out.text
            : `${out.text}\n(warning: updating the sandbox preview env failed: ${r.stderr.slice(0, 200)})`,
      };
    }
    if (call.tool === "edit") {
      if (typeof args.oldText !== "string" || !args.oldText || typeof args.newText !== "string")
        throw new ApiError(400, "oldText and newText must be strings");
      const file = sandboxArgv("read", { path: args.path });
      const current = await run(file.argv);
      if (current.exitCode !== 0) throw new ApiError(404, "Sandbox file not found");
      if (current.stdout.split(args.oldText).length !== 2)
        throw new ApiError(409, "Edit must match exactly once");
      const digest = createHash("sha256").update(current.stdout).digest("hex");
      const target = file.argv[2]!;
      // Write only if the file is unchanged since the read (exit 75: definitely not applied).
      const r = await run(
        [
          "sh",
          "-c",
          '[ "$(sha256sum < "$1" | cut -d" " -f1)" = "$2" ] || { echo "file changed since read" >&2; exit 75; }; cat > "$1"',
          "sh",
          target,
          digest,
        ],
        current.stdout.replace(args.oldText, args.newText),
      );
      if (r.exitCode === 75) throw new ApiError(409, "File changed during edit; not applied");
      if (r.exitCode !== 0)
        throw new ApiError(502, `Edit failed in sandbox: ${r.stderr.slice(0, 500)}`);
      return { text: "File edited in sandbox", productionData: false };
    }
    const { argv, stdin } = sandboxArgv(call.tool, args);
    const r = await run(argv, stdin);
    const limited = (text: string) => (r.truncated ? `${text}\n[output truncated]` : text);
    switch (call.tool) {
      case "bash":
        return {
          text:
            limited(`${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`) +
            `\n[exit ${r.exitCode}]`,
          productionData: false,
        };
      case "read": {
        if (r.exitCode !== 0) throw new ApiError(404, "Sandbox file not found");
        // The window was already cut in the sandbox (sed -n a,bp) when offset/limit were given.
        return {
          text: limited(argv[0] === "sed" ? r.stdout.replace(/\n$/, "") : r.stdout),
          productionData: false,
        };
      }
      case "write":
        // A failed write may have partly applied: 5xx keeps the ledger's "unknown" semantics.
        if (r.exitCode !== 0)
          throw new ApiError(502, `Write failed in sandbox: ${r.stderr.slice(0, 500)}`);
        return { text: "File written in sandbox", productionData: false };
      case "ls": {
        if (r.exitCode !== 0) throw new ApiError(404, "Sandbox directory not found");
        const limit = typeof args.limit === "number" ? args.limit : 500;
        return {
          text: limited(r.stdout.split("\n").filter(Boolean).sort().slice(0, limit).join("\n")),
          productionData: false,
        };
      }
      case "find": {
        const base = argv[1]!.endsWith("/") ? argv[1]! : `${argv[1]!}/`;
        const match = globMatcher(String(args.pattern));
        const limit = typeof args.limit === "number" ? args.limit : 1000;
        const found = r.stdout
          .split("\n")
          .filter((f) => f.startsWith(base))
          .map((f) => f.slice(base.length))
          .filter(match)
          .sort()
          .slice(0, limit);
        return { text: limited(found.join("\n") || "No files found"), productionData: false };
      }
      case "grep": {
        // grep exits 1 for "no matches" and 2 for errors.
        if (r.exitCode === 1) return { text: "No matches found", productionData: false };
        if (r.exitCode !== 0) throw new ApiError(400, `grep failed: ${r.stderr.slice(0, 500)}`);
        const glob = typeof args.glob === "string" ? globMatcher(args.glob) : () => true;
        const limit = typeof args.limit === "number" ? args.limit : 100;
        const lines = r.stdout
          .split("\n")
          .filter(Boolean)
          .filter((l) => glob(l.replace(/^\/workspace\//, "").split(/[:-]\d+[:-]/)[0]!))
          .map((l) => l.replace(/^\/workspace\//, ""))
          .slice(0, limit);
        return { text: limited(lines.join("\n") || "No matches found"), productionData: false };
      }
      default:
        throw new ApiError(403, "Tool unavailable");
    }
  }
}

/**
 * Exec transport through the Nomad CLI (`nomad alloc exec`) against the local agent. The argv
 * goes straight to the allocation's single task; nothing runs in a host shell. Output beyond
 * outputLimitBytes is cut and flagged.
 */
export class NomadCliTransport implements HandsTransport {
  constructor(
    private readonly bin = "nomad",
    private readonly env: Record<string, string> = {},
  ) {}
  exec(binding: HandsBinding, request: HandsExecRequest, signal?: AbortSignal) {
    if (!binding.allocId) throw new ApiError(409, "Hands allocation not ready", "hands_not_ready");
    const args = [
      "alloc",
      "exec",
      "-t=false",
      `-i=${request.stdin !== undefined}`,
      binding.allocId,
      ...request.argv,
    ];
    return new Promise<HandsExecResult>((resolvePromise, reject) => {
      const child = execFile(
        this.bin,
        args,
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...this.env },
          maxBuffer: Math.max(1, request.outputLimitBytes) * 4,
          signal,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          if (error && typeof code !== "number") {
            if ((error as { name?: string }).name === "AbortError") return reject(error);
            if (code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(error);
          }
          const lim = request.outputLimitBytes;
          const truncated = stdout.length > lim || stderr.length > lim;
          resolvePromise({
            exitCode: typeof code === "number" ? code : error ? 1 : 0,
            stdout: stdout.slice(0, lim),
            stderr: stderr.slice(0, lim),
            truncated,
          });
        },
      );
      if (request.stdin !== undefined) child.stdin?.end(request.stdin);
      else child.stdin?.end();
    });
  }
}

/**
 * Per-user cap on running sandboxes (MAX_SANDBOXES_PER_USER, default 3). Counts the owner's
 * conversations whose hands are requested/allocating/ready/stopping, other than this one.
 * Best effort under concurrency (two simultaneous starts can both pass); the cluster-wide
 * capacity limit (Nomad resources) still applies on top.
 */
export function sandboxQuota(
  store: Pick<Store, "list">,
  limit: number,
): (owner: string, conversationId: string) => Promise<void> {
  return async (owner, conversationId) => {
    if (!(limit > 0)) return;
    let running = 0;
    let after: string | undefined;
    for (;;) {
      const page = await store.list(owner, { limit: 200, ...(after ? { after } : {}) });
      for (const c of page.items)
        if (c.id !== conversationId && c.hands && [...ACTIVE, "stopping"].includes(c.hands.state))
          running++;
      if (page.next === null) break;
      after = page.next;
    }
    if (running >= limit)
      throw new ApiError(
        429,
        `You already have ${running} sandboxes running (limit ${limit}). Stop or delete another conversation's sandbox, or wait for one to go idle, then try again.`,
        "sandbox_quota",
      );
  };
}
