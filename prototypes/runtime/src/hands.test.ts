import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, SqliteStore, initial, read } from "./store.ts";
import { SandboxBroker } from "./sandbox.ts";
import { DEFAULT_TOOL_POLICIES } from "./ledger.ts";
import {
  CommandNetworkProvisioner,
  HandsJobTemplate,
  HandsSandbox,
  NomadHttpApi,
  assertKataJob,
  NomadKataHands,
  handsKey,
  sandboxNetworkName,
  type EgressPolicy,
  type EgressPolicyWriter,
  type HandsExecRequest,
  type HandsTransport,
  type SandboxNetwork,
  type SandboxNetworkProvisioner,
} from "./hands.ts";

/** A syntactically valid placeholder certificate (the template only checks the PEM shape). */
const CA_PEM = "-----BEGIN CERTIFICATE-----\nVEVTVC1DQQ==\n-----END CERTIFICATE-----\n";
const netFor = (key: string, third = 0): SandboxNetwork => ({
  name: sandboxNetworkName(key),
  ipv4: `10.90.${third}.2`,
  gateway: `10.90.${third}.1`,
});
const placement = (key: string) => ({ network: netFor(key), caPem: CA_PEM });
/** Stand-ins for egress/node/sandbox-netctl and the proxy's policy directory; both log into `log`. */
class FakeNetworks implements SandboxNetworkProvisioner {
  calls: string[] = [];
  fail?: Error;
  answer?: (key: string) => unknown;
  constructor(private readonly log: string[]) {}
  async ensure(key: string) {
    this.calls.push(key);
    this.log.push(`network ${key}`);
    if (this.fail) throw this.fail;
    return (this.answer?.(key) ?? netFor(key)) as SandboxNetwork;
  }
  released: string[] = [];
  failRelease?: Error;
  async release(key: string) {
    this.log.push(`release ${key}`);
    if (this.failRelease) throw this.failRelease;
    this.released.push(key);
  }
}
class RecordingPolicies implements EgressPolicyWriter {
  applied: EgressPolicy[] = [];
  fail?: Error;
  constructor(private readonly log: string[]) {}
  async apply(policy: EgressPolicy) {
    this.log.push(`policy ${policy.conversationKey}`);
    if (this.fail) throw this.fail;
    this.applied.push(structuredClone(policy));
  }
}

type Mode = "gate" | "fail-placement" | "fail-task";
interface FakeAlloc {
  ID: string;
  ClientStatus: string;
  DesiredStatus: string;
  TaskStates?: Record<string, unknown>;
}
/**
 * A deterministic stand-in for Nomad's HTTP API. Status codes and error strings are the ones a real
 * Nomad 2.0.7 dev agent returned on the box: create-only conflict = 500 "Enforcing job modify
 * index 0: job already exists", unknown job = 404 "job not found", placement failure = no
 * allocations plus an evaluation with FailedTGAllocs and a BlockedEval.
 */
class FakeNomad {
  mode: Mode = "gate";
  jobs = new Map<string, { job: Record<string, unknown>; allocs: FakeAlloc[]; evals: unknown[] }>();
  requests: string[] = [];
  registerCalls = 0;
  created: string[] = [];
  /** Shared ordered log (network, policy, submit) to prove what happened before submission. */
  log: string[] = [];
  allocPolls = 0;
  private n = 0;
  readonly server = createServer((req, res) => void this.handle(req, res));
  addr = "";
  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const a = this.server.address();
    if (!a || typeof a === "string") throw new Error("no address");
    this.addr = `http://127.0.0.1:${a.port}`;
    return this;
  }
  close() {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(r));
  }
  private id(prefix: string) {
    return `${prefix}-${String(++this.n).padStart(4, "0")}`;
  }
  /** Gate: the pending allocation starts running only when the test says so. */
  release(jobId: string) {
    for (const a of this.jobs.get(jobId)?.allocs ?? [])
      if (a.ClientStatus === "pending") a.ClientStatus = "running";
  }
  /** Nomad replaced the allocation (node lost, rescheduled elsewhere). */
  replaceAlloc(jobId: string) {
    const j = this.jobs.get(jobId)!;
    for (const a of j.allocs) ((a.ClientStatus = "lost"), (a.DesiredStatus = "stop"));
    const fresh = { ID: this.id("alloc"), ClientStatus: "running", DesiredStatus: "run" };
    j.allocs.push(fresh);
    return fresh.ID;
  }
  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      "content-type": typeof body === "string" ? "text/plain" : "application/json",
    });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, "http://x");
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const m = url.pathname.match(/^\/v1\/job\/([^/]+)(\/allocations|\/evaluations)?$/);
    if (req.method === "POST" && url.pathname === "/v1/jobs") {
      this.registerCalls++;
      const body = JSON.parse(raw) as {
        Job: Record<string, unknown>;
        EnforceIndex?: boolean;
        JobModifyIndex?: number;
      };
      const id = String(body.Job.ID);
      this.log.push(`submit ${id}`);
      if (this.jobs.has(id) && body.EnforceIndex && body.JobModifyIndex === 0)
        return this.send(res, 500, "Enforcing job modify index 0: job already exists");
      const evalId = this.id("eval");
      const entry = { job: body.Job, allocs: [] as FakeAlloc[], evals: [] as unknown[] };
      if (this.mode === "fail-placement") {
        entry.evals.push({
          ID: evalId,
          Status: "complete",
          FailedTGAllocs: {
            hands: { NodesEvaluated: 1, ConstraintFiltered: { "missing drivers": 1 } },
          },
          BlockedEval: this.id("eval"),
        });
      } else {
        entry.evals.push({ ID: evalId, Status: "complete", FailedTGAllocs: null });
        entry.allocs.push(
          this.mode === "fail-task"
            ? {
                ID: this.id("alloc"),
                ClientStatus: "failed",
                DesiredStatus: "run",
                TaskStates: {
                  hands: {
                    State: "dead",
                    Failed: true,
                    Events: [
                      { Type: "Received", DisplayMessage: "Task received by client" },
                      {
                        Type: "Driver Failure",
                        DisplayMessage: 'requested runtime "kata" is not allowed',
                      },
                    ],
                  },
                },
              }
            : { ID: this.id("alloc"), ClientStatus: "pending", DesiredStatus: "run" },
        );
      }
      this.jobs.set(id, entry);
      this.created.push(id);
      return this.send(res, 200, { EvalID: evalId, JobModifyIndex: 10 + this.n });
    }
    if (m) {
      const j = this.jobs.get(decodeURIComponent(m[1]!));
      if (req.method === "DELETE") {
        if (!j) return this.send(res, 404, "job not found");
        this.jobs.delete(decodeURIComponent(m[1]!));
        return this.send(res, 200, { EvalID: this.id("eval") });
      }
      if (m[2] === "/allocations") return (this.allocPolls++, this.send(res, 200, j?.allocs ?? []));
      if (m[2] === "/evaluations") return this.send(res, 200, j?.evals ?? []);
      return j ? this.send(res, 200, j.job) : this.send(res, 404, "job not found");
    }
    this.send(res, 404, "Invalid URL");
  }
}
const until = async (f: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 2000; i++) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
};
async function setup(t: { after: (f: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "hands-test-"));
  const file = join(dir, "state.sqlite");
  const stores: SqliteStore[] = [];
  const openStore = () => {
    const s = new SqliteStore(file);
    stores.push(s);
    return s;
  };
  const fake = await new FakeNomad().start();
  t.after(async () => {
    await fake.close();
    for (const s of stores) await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  const store = openStore();
  await store.create(initial("c1", "alice"));
  const template = HandsJobTemplate.load();
  const networks = new FakeNetworks(fake.log);
  const policies = new RecordingPolicies(fake.log);
  const rules = [{ host: "api.github.com", inject: "github" }];
  const sandbox = {
    network: networks,
    egress: { writer: policies, rules: () => structuredClone(rules), caPem: CA_PEM },
  };
  const hands = (s = store, options: ConstructorParameters<typeof NomadKataHands>[2] = {}) =>
    new NomadKataHands(s, new NomadHttpApi(fake.addr), {
      template,
      pollMs: 2,
      sandbox,
      ...options,
    });
  return { fake, store, openStore, hands, template, networks, policies, rules };
}
/**
 * Stands in for the sandbox: interprets exactly the argv shapes sandboxArgv() emits against an
 * in-memory /workspace. Nothing here touches the host filesystem or spawns a process.
 */
class VirtualSandbox implements HandsTransport {
  calls: Array<{ allocId?: string; request: HandsExecRequest }> = [];
  files = new Map<string, string>();
  async exec(binding: { allocId?: string }, request: HandsExecRequest) {
    this.calls.push({ allocId: binding.allocId, request });
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", truncated: false });
    const err = (exitCode: number, stderr: string) => ({
      exitCode,
      stdout: "",
      stderr,
      truncated: false,
    });
    const [cmd, ...rest] = request.argv;
    const under = (dir: string) =>
      [...this.files.keys()].filter((f) =>
        f.startsWith(dir === "/workspace" ? "/workspace/" : `${dir}/`),
      );
    if (cmd === "true") return ok();
    if (cmd === "cat" && rest[0] === "--") {
      const v = this.files.get(rest[1]!);
      return v === undefined ? err(1, "No such file") : ok(v);
    }
    if (cmd === "sed" && rest[0] === "-n" && rest[2] === "--") {
      const v = this.files.get(rest[3]!);
      if (v === undefined) return err(2, "No such file");
      const m = /^(\d+),(\d+|\$)p$/.exec(rest[1]!)!;
      const lines = v.split("\n");
      if (v.endsWith("\n")) lines.pop();
      const a = Number(m[1]) - 1;
      const b = m[2] === "$" ? lines.length : Number(m[2]);
      const out = lines.slice(a, b);
      return ok(out.length ? out.join("\n") + "\n" : "");
    }
    if (cmd === "sh" && rest[1]?.includes('cat > "$1"') && rest[1].includes("mkdir")) {
      this.files.set(rest[3]!, request.stdin ?? "");
      return ok();
    }
    if (cmd === "sh" && rest[1]?.includes("sha256sum")) {
      const { createHash } = await import("node:crypto");
      const now = createHash("sha256")
        .update(this.files.get(rest[3]!) ?? "")
        .digest("hex");
      if (now !== rest[4]) return err(75, "file changed since read");
      this.files.set(rest[3]!, request.stdin ?? "");
      return ok();
    }
    if (cmd === "sh" && rest[1]?.includes("exec bash -c")) return ok(`ran ${rest[3]}`);
    if (cmd === "ls") {
      const dir = rest[2]!;
      const names = new Set(
        under(dir).map((f) => {
          const [h, ...t] = f.slice(dir.length + 1).split("/");
          return t.length ? `${h}/` : h!;
        }),
      );
      return names.size ? ok([...names].join("\n") + "\n") : err(2, "No such directory");
    }
    if (cmd === "find") return ok(under(rest[0]!).join("\n") + "\n");
    if (cmd === "grep") {
      const e = request.argv.indexOf("-e");
      const re = new RegExp(request.argv[e + 1]!, request.argv.includes("-i") ? "i" : "");
      const out = under(request.argv.at(-1)!).flatMap((f) =>
        this.files
          .get(f)!
          .split("\n")
          .flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}:${line}`] : [])),
      );
      return out.length ? ok(out.join("\n") + "\n") : err(1, "");
    }
    return err(127, `unexpected argv ${JSON.stringify(request.argv)}`);
  }
}
class RecordingTransport extends VirtualSandbox {}

test("hands are lazy: no Nomad traffic until the first tool call, then one job and one binding", async (t) => {
  const { fake, store, hands } = await setup(t);
  const transport = new RecordingTransport();
  const provider = hands(store, { transport });
  // Default policy: sandbox bash is sandbox work (no taint), its egress goes through the proxy.
  const broker = new SandboxBroker(store, new HandsSandbox(provider));
  assert.deepEqual(fake.requests, [], "constructing the provider and broker talks to nobody");
  assert.equal((await read(store, "alice", "c1")).hands, undefined);
  fake.mode = "gate";
  const first = broker.execute("alice", "c1", {
    id: "call-1",
    tool: "bash",
    args: { command: "uname -r" },
  });
  await until(() => fake.created.length === 1 && fake.allocPolls > 0, "registration");
  const key = handsKey("alice", "c1");
  assert.deepEqual(fake.created, [`hands-${key}-g1`]);
  assert.equal((await read(store, "alice", "c1")).hands?.state, "allocating");
  fake.release(`hands-${key}-g1`);
  const result = await first;
  assert.match(result.text, /ran uname -r/);
  const c = await read(store, "alice", "c1");
  assert.equal(c.tainted, false, "sandbox work does not taint");
  const allocId = fake.jobs.get(`hands-${key}-g1`)!.allocs[0]!.ID;
  assert.equal(c.hands?.state, "ready");
  assert.equal(c.hands?.allocId, allocId);
  assert.equal(c.sandbox, `nomad-kata:ws-${key}`);
  // Execution ID, epoch and generation reach the hands side.
  const [call] = transport.calls;
  assert.equal(call?.allocId, allocId);
  assert.equal(call?.request.callId, "call-1");
  assert.equal(call?.request.epoch, 0);
  assert.equal(call?.request.generation, 1);
  assert.ok(call?.request.execId && call.request.execId === Object.keys(c.ledger ?? {})[0]);
  assert.deepEqual(
    c.events.filter((e) => e.type === "hands.state").map((e) => e.data.state),
    ["requested", "allocating", "ready"],
  );
  // The registered job is the reviewed template: Kata runtime, not privileged, pinned image, limits.
  const job = fake.jobs.get(`hands-${key}-g1`)!.job as {
    TaskGroups: Array<{
      Tasks: Array<{ Config: Record<string, unknown>; Resources: Record<string, unknown> }>;
    }>;
    Meta: Record<string, string>;
  };
  const task = job.TaskGroups[0]!.Tasks[0]!;
  assert.equal(task.Config.runtime, "kata");
  assert.equal(task.Config.privileged, undefined);
  assert.match(String(task.Config.image), /@sha256:[0-9a-f]{64}$/);
  assert.deepEqual([task.Resources.CPU, task.Resources.MemoryMB], [4000, 8192]);
  assert.deepEqual(job.Meta, {
    template: "hands-kata-dind/v1",
    conversation_key: key,
    generation: "1",
    workspace_id: `ws-${key}`,
  });
  // A second call reuses the binding: no new registration.
  await broker.execute("alice", "c1", { id: "call-2", tool: "bash", args: { command: "true" } });
  assert.equal(fake.registerCalls, 1);
});

test("policy runs before allocation: a refused call never starts a sandbox", async (t) => {
  const { fake, store, hands } = await setup(t);
  const transport = new VirtualSandbox();
  // A production read earlier in the conversation tainted it.
  await store.mutate("alice", "c1", (c) => void (c.tainted = true));
  // Without an egress boundary, "proxied" bash egress is denied after taint, before any allocation.
  const plain = new SandboxBroker(store, new HandsSandbox(hands(store, { transport })));
  await assert.rejects(
    plain.execute("alice", "c1", { id: "b1", tool: "bash", args: { command: "curl x" } }),
    (e: unknown) =>
      e instanceof ApiError && e.status === 403 && /production-data ingress/.test(e.message),
  );
  assert.deepEqual(fake.requests, [], "no Nomad call: nothing was allocated");
  assert.equal((await read(store, "alice", "c1")).hands, undefined);
  // A blocked ledger (unknown outcome) also refuses before allocation.
  await store.create(initial("c2", "alice"));
  await store.mutate("alice", "c2", (c) => {
    c.ledger = {
      xold: {
        execId: "xold",
        callId: "old",
        tool: "write",
        replay: "non-idempotent",
        destination: "sandbox",
        argsDigest: "d",
        args: {},
        policyVersion: "v",
        epoch: 0,
        attempts: 1,
        status: "unknown",
      },
    };
  });
  await assert.rejects(
    plain.execute("alice", "c2", { id: "b2", tool: "read", args: { path: "a" } }),
    (e: unknown) => e instanceof ApiError && e.code === "tool_outcome_unknown",
  );
  assert.deepEqual(fake.requests, []);
  // A production-destination tool taints and is refused (egress) before allocation too.
  await store.create(initial("c3", "alice"));
  const prodPolicies = {
    ...DEFAULT_TOOL_POLICIES,
    prod_export: {
      replay: "non-idempotent" as const,
      destination: "production" as const,
      egress: true,
    },
  };
  const prodBroker = new SandboxBroker(store, new HandsSandbox(hands(store, { transport })), {
    policies: prodPolicies,
  });
  await assert.rejects(
    prodBroker.execute("alice", "c3", { id: "p1", tool: "prod_export", args: {} }),
    /production-data ingress/,
  );
  assert.equal((await read(store, "alice", "c3")).tainted, true);
  assert.deepEqual(fake.requests, []);
});

test("with the proxy as boundary, tainted bash runs and the proxy receives the taint and trusted allowlist", async (t) => {
  const { fake, store, hands } = await setup(t);
  const transport = new VirtualSandbox();
  const applied: unknown[] = [];
  const egress = { apply: async (p: unknown) => void applied.push(structuredClone(p)) };
  const rules = [{ host: "api.github.com", ports: [443], inject: "github" }];
  const sandbox = new HandsSandbox(hands(store, { transport }), {
    egress,
    egressRules: (owner, id) => (owner === "alice" && id === "c1" ? rules : []),
  });
  assert.equal(sandbox.egressBoundary, "proxy");
  const broker = new SandboxBroker(store, sandbox);
  await store.mutate("alice", "c1", (c) => void (c.tainted = true));
  const pending = broker.execute("alice", "c1", {
    id: "b1",
    tool: "bash",
    args: { command: "git fetch" },
  });
  await until(() => fake.allocPolls > 0, "allocation");
  fake.release(fake.created[0]!);
  assert.match((await pending).text, /ran git fetch/);
  assert.deepEqual(applied, [
    {
      version: 1,
      conversationKey: handsKey("alice", "c1"),
      workspaceId: `ws-${handsKey("alice", "c1")}`,
      tainted: true,
      rules,
    },
  ]);
  // The agent's arguments cannot reach the policy: only the trusted resolver supplies rules.
  assert.equal(JSON.stringify(applied).includes("git fetch"), false);
  // Direct-egress tools stay denied after taint regardless of the proxy.
  const direct = new SandboxBroker(store, sandbox, {
    policies: {
      ...DEFAULT_TOOL_POLICIES,
      upload: { replay: "non-idempotent", destination: "sandbox", egress: true },
    },
  });
  await assert.rejects(
    direct.execute("alice", "c1", { id: "u1", tool: "upload", args: {} }),
    /egress-capable/,
  );
});

test("every Pi tool runs in the sandbox through argv, never a host shell", async (t) => {
  const { fake, store, hands } = await setup(t);
  const transport = new VirtualSandbox();
  const broker = new SandboxBroker(store, new HandsSandbox(hands(store, { transport })));
  const run = (id: string, tool: string, args: Record<string, unknown>) =>
    broker.execute("alice", "c1", { id, tool, args });
  const first = run("w1", "write", { path: "src/a.ts", content: "one\ntwo needle\nthree" });
  await until(() => fake.allocPolls > 0, "allocation");
  fake.release(fake.created[0]!);
  await first;
  assert.equal(transport.files.get("/workspace/src/a.ts"), "one\ntwo needle\nthree");
  assert.equal(
    (await run("r1", "read", { path: "/workspace/src/a.ts", offset: 2, limit: 1 })).text,
    "two needle",
  );
  await run("e1", "edit", { path: "src/a.ts", oldText: "two", newText: "TWO" });
  assert.equal(transport.files.get("/workspace/src/a.ts"), "one\nTWO needle\nthree");
  await assert.rejects(
    run("e2", "edit", { path: "src/a.ts", oldText: "missing", newText: "x" }),
    /exactly once/,
  );
  await run("w2", "write", { path: "README.md", content: "needle here" });
  assert.equal((await run("l1", "ls", {})).text, "README.md\nsrc/");
  assert.equal((await run("f1", "find", { pattern: "*.ts" })).text, "src/a.ts");
  assert.equal(
    (await run("g1", "grep", { pattern: "needle", glob: "*.md" })).text,
    "README.md:1:needle here",
  );
  assert.equal((await run("g2", "grep", { pattern: "absent" })).text, "No matches found");
  const bash = await run("b1", "bash", { command: "echo '$(rm -rf /)'; ls" });
  assert.match(bash.text, /^ran echo '\$\(rm -rf \/\)'; ls/);
  await assert.rejects(
    run("r2", "read", { path: "../../etc/passwd" }),
    /Invalid sandbox path|outside/,
  );
  // The command is one argv element handed to the sandbox's shell; argv never names a host path.
  const bashCall = transport.calls.find((c) => c.request.callId === "b1")!;
  assert.equal(bashCall.request.argv.at(-1), "echo '$(rm -rf /)'; ls");
  for (const c of transport.calls)
    for (const a of c.request.argv.filter((x) => x.startsWith("/")))
      assert.ok(a.startsWith("/workspace"), `argv path ${a} stays in /workspace`);
  const c = await read(store, "alice", "c1");
  assert.equal(c.tainted, false);
  assert.equal(
    c.events.filter((e) => e.type === "tool.result").length,
    9,
    "every successful call recorded once",
  );
});

test("the backend refuses to submit any job that does not use the kata runtime", async (t) => {
  const { fake, store, hands, template } = await setup(t);
  const good = template.render("0123456789abcdef", 1, "ws-x", placement("0123456789abcdef"));
  assert.doesNotThrow(() => assertKataJob(good));
  const strip = (f: (task: { Driver?: string; Config: Record<string, unknown> }) => void) => {
    const j = structuredClone(good) as {
      TaskGroups: Array<{ Tasks: Array<{ Driver?: string; Config: Record<string, unknown> }> }>;
    };
    f(j.TaskGroups[0]!.Tasks[0]!);
    return j as unknown as Record<string, unknown>;
  };
  const noRuntime = strip((t) => delete t.Config.runtime);
  for (const bad of [
    noRuntime,
    strip((t) => (t.Config.runtime = "runc")),
    strip((t) => (t.Driver = "exec")),
    strip((t) => (t.Config.privileged = true)),
    { ID: "empty", TaskGroups: [] },
  ])
    assert.throws(
      () => assertKataJob(bad),
      (e: unknown) => e instanceof ApiError && e.code === "hands_job_refused",
    );
  // The HTTP client refuses before sending anything.
  await assert.rejects(new NomadHttpApi(fake.addr).registerNew(noRuntime), /runtime "kata"/);
  assert.deepEqual(fake.requests, []);
  // The provider refuses too, even if a template object were tampered with after loading.
  const tampered = Object.create(template) as HandsJobTemplate;
  tampered.render = (
    k: string,
    g: number,
    w: string,
    p: Parameters<HandsJobTemplate["render"]>[3],
  ) => {
    const j = template.render(k, g, w, p) as {
      TaskGroups: Array<{ Tasks: Array<{ Config: Record<string, unknown> }> }>;
    };
    delete j.TaskGroups[0]!.Tasks[0]!.Config.runtime;
    return j as unknown as Record<string, unknown>;
  };
  await assert.rejects(
    hands(store, { template: tampered }).ensure("alice", "c1"),
    (e: unknown) =>
      e instanceof ApiError &&
      e.code === "hands_allocation_failed" &&
      /runtime "kata"/.test(e.message),
  );
  assert.equal(fake.registerCalls, 0, "nothing reached Nomad");
  assert.equal((await read(store, "alice", "c1")).hands?.state, "failed");
});

test("racing first calls from two workers produce exactly one job and one binding", async (t) => {
  const { fake, openStore, hands } = await setup(t);
  const a = hands(openStore()),
    b = hands(openStore());
  const all = Promise.all([
    a.ensure("alice", "c1"),
    b.ensure("alice", "c1"),
    a.ensure("alice", "c1"),
    b.ensure("alice", "c1"),
  ]);
  await until(() => fake.created.length === 1 && fake.allocPolls >= 4, "all racers polling");
  fake.release(fake.created[0]!);
  const bindings = await all;
  assert.equal(fake.created.length, 1, "one job created");
  assert.equal(fake.jobs.get(fake.created[0]!)!.allocs.length, 1, "one allocation");
  assert.equal(
    new Set(bindings.map((x) => `${x.jobId}/${x.allocId}/${x.generation}/${x.state}`)).size,
    1,
  );
  const c = await read(openStore(), "alice", "c1");
  assert.equal(
    c.events.filter((e) => e.type === "hands.state" && e.data.state === "requested").length,
    1,
  );
  assert.equal(
    c.events.filter((e) => e.type === "hands.state" && e.data.state === "ready").length,
    1,
  );
});

test("a restarted worker reconciles the existing allocation instead of creating another", async (t) => {
  const { fake, openStore, hands } = await setup(t);
  const crash = new AbortController();
  const before = hands(openStore(), { signal: crash.signal });
  const pending = before.ensure("alice", "c1");
  await until(() => fake.allocPolls > 0, "first worker polling");
  crash.abort(new Error("worker died"));
  await assert.rejects(pending, /worker died/);
  const store = openStore();
  assert.equal(
    (await read(store, "alice", "c1")).hands?.state,
    "allocating",
    "persisted mid-allocation",
  );
  fake.release(fake.created[0]!);
  const after = hands(store);
  const b = await after.reconcile("alice", "c1");
  assert.equal(b?.state, "ready");
  assert.equal(b?.allocId, fake.jobs.get(fake.created[0]!)!.allocs[0]!.ID);
  assert.equal(fake.registerCalls, 1, "no second registration");
  // Nomad later replaces the allocation: reconcile follows it without a new job.
  const replaced = fake.replaceAlloc(fake.created[0]!);
  assert.equal((await after.reconcile("alice", "c1"))?.allocId, replaced);
  assert.equal(fake.created.length, 1);
  // The job vanishes behind our back: that is a failure, never a silent re-create or host fallback.
  fake.jobs.clear();
  assert.equal((await after.reconcile("alice", "c1"))?.state, "failed");
  await assert.rejects(
    after.ensure("alice", "c1"),
    (e: unknown) =>
      e instanceof ApiError && e.status === 503 && e.code === "hands_allocation_failed",
  );
  assert.equal(fake.created.length, 1);
});

test("allocation failure is a real failure: persisted, purged, no fallback, no retry loop", async (t) => {
  const { fake, store, hands } = await setup(t);
  const transport = new RecordingTransport();
  fake.mode = "fail-placement";
  const provider = hands(store, { transport });
  const broker = new SandboxBroker(store, new HandsSandbox(provider));
  await assert.rejects(
    broker.execute("alice", "c1", { id: "call-1", tool: "bash", args: { command: "echo hi" } }),
    (e: unknown) =>
      e instanceof ApiError && e.status === 503 && /placement failed \(hands\)/.test(e.message),
  );
  let c = await read(store, "alice", "c1");
  assert.equal(c.hands?.state, "failed");
  assert.equal(c.sandbox, null, "no sandbox bound");
  assert.equal(c.events.filter((e) => e.type === "tool.result").length, 0);
  assert.equal(transport.calls.length, 0, "nothing executed anywhere");
  assert.equal(fake.jobs.size, 0, "the unplaceable job was purged");
  const registers = fake.registerCalls;
  await assert.rejects(provider.ensure("alice", "c1"), /placement failed/);
  assert.equal(fake.registerCalls, registers, "a failed generation is not silently retried");
  // A task that fails to start (here: the agent refusing the runtime) is reported with Nomad's reason.
  await store.create(initial("c2", "alice"));
  fake.mode = "fail-task";
  await assert.rejects(
    provider.ensure("alice", "c2"),
    /Driver Failure: requested runtime "kata" is not allowed/,
  );
  c = await read(store, "alice", "c2");
  assert.equal(c.hands?.state, "failed");
  // A timeout fails the generation too.
  await store.create(initial("c3", "alice"));
  fake.mode = "gate";
  await assert.rejects(
    hands(store, { allocationTimeoutMs: 20 }).ensure("alice", "c3"),
    /no running allocation within 20 ms/,
  );
});

test("exec refuses without a transport, with a stale generation, and before ready; stop keeps the workspace", async (t) => {
  const { fake, store, hands } = await setup(t);
  const provider = hands(store);
  const request = {
    execId: "x1",
    epoch: 0,
    callId: "c",
    argv: ["true"],
    deadlineMs: 1000,
    outputLimitBytes: 1024,
  };
  await assert.rejects(
    provider.exec("alice", "c1", request),
    (e: unknown) => e instanceof ApiError && e.code === "hands_not_ready",
  );
  const ensured = provider.ensure("alice", "c1");
  await until(() => fake.allocPolls > 0, "polling");
  fake.release(fake.created[0]!);
  const b1 = await ensured;
  await assert.rejects(
    provider.exec("alice", "c1", request),
    (e: unknown) => e instanceof ApiError && e.status === 501,
  );
  const withTransport = hands(store, { transport: new RecordingTransport() });
  await assert.rejects(
    withTransport.exec("alice", "c1", { ...request, generation: 7 }),
    /Stale hands generation 7/,
  );
  assert.equal(
    (await withTransport.exec("alice", "c1", { ...request, generation: 1 })).exitCode,
    0,
  );
  const stopped = await provider.stop("alice", "c1");
  assert.equal(stopped?.state, "stopped");
  assert.equal(fake.jobs.size, 0);
  assert.equal((await provider.stop("alice", "c1"))?.state, "stopped", "stop is idempotent");
  const next = provider.ensure("alice", "c1");
  await until(() => fake.created.length === 2 && fake.allocPolls > 2, "second generation");
  fake.release(fake.created[1]!);
  const b2 = await next;
  assert.equal(b2.generation, 2);
  assert.notEqual(b2.jobId, b1.jobId, "new compute");
  assert.equal(b2.workspaceId, b1.workspaceId, "same workspace identity");
  await assert.rejects(
    withTransport.exec("alice", "c1", { ...request, generation: 1 }),
    /Stale hands generation 1/,
  );
});

test("the template is the reviewed kit file and refuses unsafe edits", async () => {
  const template = HandsJobTemplate.load();
  const job = template.render("0123456789abcdef", 1, "ws-x", placement("0123456789abcdef")) as {
    ID: string;
    TaskGroups: Array<{ Tasks: Array<{ Config: { args: string[] } }> }>;
  };
  assert.equal(job.ID, "hands-0123456789abcdef-g1");
  const entry = await readFile(
    fileURLToPath(new URL("../../../infra/sandbox-kit/inner/dind-entry.sh", import.meta.url)),
    "utf8",
  );
  assert.equal(
    job.TaskGroups[0]!.Tasks[0]!.Config.args[1],
    entry,
    "embedded entry script matches inner/dind-entry.sh",
  );
  // Nomad interpolates ${...} in task config at submit time, so the script must not use it.
  assert.ok(!entry.includes("${"), "entry script has no ${...} (Nomad would interpolate it)");
  assert.throws(
    () => template.render("../etc/passwd", 1, "ws", placement("0123456789abcdef")),
    /invalid key/,
  );
  assert.throws(
    () => template.render("0123456789abcdef", 0, "ws", placement("0123456789abcdef")),
    /invalid key/,
  );
  // Per-sandbox inputs are validated too: another conversation's network, a bad CA.
  assert.throws(
    () => template.render("0123456789abcdef", 1, "ws", placement("ffffffffffffffff")),
    /is not sbx0123456789ab/,
  );
  assert.throws(
    () =>
      template.render("0123456789abcdef", 1, "ws", {
        network: netFor("0123456789abcdef"),
        caPem: '{{ env "NOMAD_TOKEN" }}',
      }),
    /one PEM certificate/,
  );
  const raw = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../../../infra/sandbox-kit/nomad/hands.job.json", import.meta.url)),
      "utf8",
    ),
  ).Job;
  const edit = (f: (cfg: Record<string, unknown>) => void) => {
    const j = structuredClone(raw);
    f(j.TaskGroups[0].Tasks[0].Config);
    return () => HandsJobTemplate.fromJob(j);
  };
  assert.throws(
    edit((c) => (c.runtime = "runc")),
    /runtime must be kata/,
  );
  assert.throws(
    edit((c) => (c.privileged = true)),
    /privileged/,
  );
  assert.throws(
    edit(
      (c) =>
        (c.mount = [
          { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
        ]),
    ),
    /only tmpfs/,
  );
  for (const mode of ["host", "bridge", "default", "none", "container:x", undefined])
    assert.throws(
      edit((c) => (c.network_mode = mode)),
      /sandbox network/,
    );
  assert.throws(() => {
    const j = structuredClone(raw);
    j.TaskGroups[0].Networks = [{ Mode: "bridge" }];
    return HandsJobTemplate.fromJob(j);
  }, /no group network/);
  assert.throws(
    edit((c) => (c.image = "docker:dind")),
    /pinned by digest/,
  );
});

type JobShape = {
  TaskGroups: Array<{
    Networks?: unknown;
    Tasks: Array<{
      Config: Record<string, unknown>;
      Env: Record<string, string>;
      Templates: Array<{ DestPath: string; EmbeddedTmpl: string }>;
    }>;
  }>;
};

test("the network is bound and the allowlist registered with the proxy before the job is submitted", async (t) => {
  const { fake, store, hands, networks, policies, rules } = await setup(t);
  const key = handsKey("alice", "c1");
  const pending = hands().ensure("alice", "c1");
  await until(() => fake.created.length === 1, "job submitted");
  fake.release(fake.created[0]!);
  const b = await pending;
  assert.deepEqual(fake.log, [`network ${key}`, `policy ${key}`, `submit ${b.jobId}`]);
  assert.deepEqual(networks.calls, [key]);
  assert.deepEqual(policies.applied, [
    { version: 1, conversationKey: key, workspaceId: b.workspaceId, tainted: false, rules },
  ]);
  // The submitted job is on exactly this conversation's network, with its proxy and CA.
  const task = (fake.jobs.get(b.jobId)!.job as unknown as JobShape).TaskGroups[0]!.Tasks[0]!;
  const net = netFor(key);
  assert.equal(task.Config.network_mode, net.name);
  assert.equal(task.Config.ipv4_address, net.ipv4);
  assert.deepEqual(task.Config.dns_servers, [net.gateway]);
  assert.equal(task.Env.SANDBOX_DNS, net.gateway, "resolv.conf points at the gateway");
  assert.equal(task.Config.runtime, "kata");
  // Transparent egress: no proxy variables at all, only CA trust (the Vercel Sandbox set).
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy"])
    assert.equal(task.Env[k], undefined, `${k} must not be set`);
  assert.equal(task.Env.SSL_CERT_FILE, "/etc/ssl/certs/ca-certificates.crt");
  assert.equal(task.Env.NODE_USE_SYSTEM_CA, "1");
  assert.equal(task.Env.PIP_CERT, "/etc/ssl/certs/ca-certificates.crt");
  assert.equal(task.Templates[0]!.EmbeddedTmpl, CA_PEM);
  assert.equal(task.Templates[0]!.DestPath, "local/egress-ca.pem");
  // A tainted conversation is registered as tainted before its compute exists.
  await store.create(initial("c2", "alice"));
  await store.mutate("alice", "c2", (c) => {
    c.tainted = true;
  });
  const second = hands().ensure("alice", "c2");
  await until(() => fake.created.length === 2, "second job");
  fake.release(fake.created[1]!);
  await second;
  assert.equal(policies.applied.at(-1)?.tainted, true);
  assert.equal(policies.applied.at(-1)?.conversationKey, handsKey("alice", "c2"));
});

test("nothing is submitted when the network or the proxy registration fails, and a retry recovers", async (t) => {
  const { fake, store, hands, networks, policies } = await setup(t);
  const unavailable = (e: unknown) =>
    e instanceof ApiError && e.status === 503 && e.code === "hands_egress_unavailable";
  policies.fail = new Error("EACCES: policy dir");
  await assert.rejects(hands().ensure("alice", "c1"), (e: unknown) => {
    assert.ok(unavailable(e));
    assert.match((e as Error).message, /Egress proxy registration failed: EACCES/);
    return true;
  });
  assert.equal(fake.registerCalls, 0, "no job without a registered allowlist");
  assert.equal((await read(store, "alice", "c1")).hands?.state, "requested", "retryable");
  policies.fail = undefined;
  networks.fail = new Error("sandbox-netctl ensure: lock timeout");
  await assert.rejects(hands().ensure("alice", "c1"), (e: unknown) => {
    assert.ok(unavailable(e));
    assert.match((e as Error).message, /Sandbox network unavailable: .*lock timeout/);
    return true;
  });
  assert.equal(fake.registerCalls, 0);
  // A provisioner answer for another conversation's network (or garbage) is refused, unsubmitted.
  networks.fail = undefined;
  for (const answer of [
    netFor("ffffffffffffffffffff"),
    {
      name: sandboxNetworkName(handsKey("alice", "c1")),
      ipv4: "169.254.169.254",
      gateway: "169.254.169.253",
    },
    { name: sandboxNetworkName(handsKey("alice", "c1")), ipv4: "10.90.0.2", gateway: "10.91.0.1" },
    "not json",
  ]) {
    networks.answer = () => answer;
    await assert.rejects(hands().ensure("alice", "c1"), unavailable);
  }
  assert.equal(fake.registerCalls, 0);
  // Fixed: the same generation submits exactly once.
  networks.answer = undefined;
  const pending = hands().ensure("alice", "c1");
  await until(() => fake.created.length === 1, "submitted after recovery");
  fake.release(fake.created[0]!);
  const b = await pending;
  assert.equal(b.generation, 1);
  assert.equal(fake.registerCalls, 1);
});

test("without a sandbox network and egress proxy configured, no job is ever submitted", async (t) => {
  const { fake, store, hands } = await setup(t);
  await assert.rejects(
    hands(store, { sandbox: undefined }).ensure("alice", "c1"),
    (e: unknown) =>
      e instanceof ApiError &&
      e.code === "hands_allocation_failed" &&
      /no sandbox network \/ egress proxy configured/.test(e.message),
  );
  assert.equal(fake.registerCalls, 0);
  assert.deepEqual(fake.requests, []);
});

test("the backend refuses any job whose network is not the conversation's sandbox network", async (t) => {
  const { fake, store, hands, template } = await setup(t);
  const key = "0123456789abcdef";
  const good = template.render(key, 1, "ws-x", placement(key));
  assert.doesNotThrow(() => assertKataJob(good, netFor(key)));
  assert.doesNotThrow(() => assertKataJob(good), "structural check without the broker's network");
  const edit = (f: (j: JobShape) => void) => {
    const j = structuredClone(good) as unknown as JobShape;
    f(j);
    return j as unknown as Record<string, unknown>;
  };
  const refused = (e: unknown) => e instanceof ApiError && e.code === "hands_job_refused";
  const cfg = (f: (c: Record<string, unknown>) => void) =>
    edit((j) => f(j.TaskGroups[0]!.Tasks[0]!.Config));
  for (const mode of [
    "bridge",
    "host",
    "default",
    "none",
    `container:${"a".repeat(12)}`,
    undefined,
  ])
    assert.throws(() => assertKataJob(cfg((c) => (c.network_mode = mode))), refused, String(mode));
  assert.throws(
    () => assertKataJob(edit((j) => (j.TaskGroups[0]!.Networks = [{ Mode: "bridge" }]))),
    refused,
  );
  assert.throws(
    () => assertKataJob(edit((j) => (j.TaskGroups[0]!.Networks = [{ Mode: "cni/sandbox" }]))),
    refused,
  );
  assert.throws(() => assertKataJob(cfg((c) => delete c.ipv4_address)), refused);
  // Another sandbox network, address or DNS than this conversation's: refused by the broker check.
  const mine = netFor(key);
  assert.throws(
    () =>
      assertKataJob(
        cfg((c) => (c.network_mode = "sbxffffffffffff")),
        mine,
      ),
    refused,
  );
  assert.throws(
    () =>
      assertKataJob(
        cfg((c) => (c.ipv4_address = "10.90.0.10")),
        mine,
      ),
    refused,
  );
  assert.throws(
    () =>
      assertKataJob(
        cfg((c) => (c.dns_servers = ["8.8.8.8"])),
        mine,
      ),
    refused,
  );
  assert.throws(
    () =>
      assertKataJob(
        cfg((c) => (c.dns_servers = [])),
        mine,
      ),
    refused,
  );
  // The HTTP client refuses a bridge-mode job before sending anything.
  await assert.rejects(
    new NomadHttpApi(fake.addr).registerNew(cfg((c) => (c.network_mode = "bridge"))),
    /sandbox network/,
  );
  assert.deepEqual(fake.requests, []);
  // A template tampered after loading to use another network never reaches Nomad.
  const tampered = Object.create(template) as HandsJobTemplate;
  tampered.render = (
    k: string,
    g: number,
    w: string,
    p: Parameters<HandsJobTemplate["render"]>[3],
  ) => {
    const j = template.render(k, g, w, p) as unknown as JobShape;
    j.TaskGroups[0]!.Tasks[0]!.Config.network_mode = "sbxffffffffffff";
    return j as unknown as Record<string, unknown>;
  };
  await assert.rejects(
    hands(store, { template: tampered }).ensure("alice", "c1"),
    (e: unknown) =>
      e instanceof ApiError &&
      e.code === "hands_allocation_failed" &&
      /not on this conversation's sandbox network/.test(e.message),
  );
  assert.equal(fake.registerCalls, 0, "nothing reached Nomad");
});

test("CommandNetworkProvisioner runs the node helper as argv and validates its answer", async () => {
  const key = "abcdef0123456789abcd";
  // Stand-in for `sudo -n sandbox-netctl`: echoes JSON built from its own argv ($1 verb, $2 key).
  const script = (body: string) => ["sh", "-c", body, "sandbox-netctl"];
  const ok = new CommandNetworkProvisioner(
    script(
      'printf \'{"name":"sbx%s","subnet":"10.90.0.0/29","gateway":"10.90.0.1","ipv4":"10.90.0.2"}\\n\' "$(echo "$2" | cut -c1-12)"',
    ),
  );
  assert.deepEqual(await ok.ensure(key), {
    name: "sbxabcdef012345",
    ipv4: "10.90.0.2",
    gateway: "10.90.0.1",
  });
  const wrong = new CommandNetworkProvisioner(
    script('echo \'{"name":"sbxsomeoneelse0","gateway":"10.90.0.1","ipv4":"10.90.0.2"}\''),
  );
  await assert.rejects(wrong.ensure(key), /is not sbxabcdef012345/);
  const failing = new CommandNetworkProvisioner(
    script('echo "sandbox-netctl: refusing to share sbx" >&2; exit 1'),
  );
  await assert.rejects(
    failing.ensure(key),
    /sandbox-netctl ensure: sandbox-netctl: refusing to share/,
  );
  // An invalid key never reaches the helper (it would land in argv of a root command).
  const never = new CommandNetworkProvisioner(script("echo should-not-run; exit 1"));
  await assert.rejects(never.ensure("../../etc"), /invalid conversation key/);
  await assert.rejects(never.ensure("abc; rm -rf /"), /invalid conversation key/);
});

test("stop purges the job, then releases the conversation's network (best effort)", async (t) => {
  const { fake, hands, networks } = await setup(t);
  const key = handsKey("alice", "c1");
  const pending = hands().ensure("alice", "c1");
  await until(() => fake.created.length === 1, "job submitted");
  fake.release(fake.created[0]!);
  await pending;
  networks.failRelease = new Error("network sbx has active endpoints");
  assert.equal(
    (await hands().stop("alice", "c1"))?.state,
    "stopped",
    "a failed release does not block stop",
  );
  assert.deepEqual(networks.released, []);
  assert.equal(fake.log.at(-1), `release ${key}`);
  // The next generation reuses (re-ensures) the same network; a later stop releases it.
  networks.failRelease = undefined;
  const again = hands().ensure("alice", "c1");
  await until(() => fake.created.length === 2, "second generation");
  fake.release(fake.created[1]!);
  assert.equal((await again).generation, 2);
  await hands().stop("alice", "c1");
  assert.deepEqual(networks.released, [key]);
});

test("a failed generation is retried after the cooldown: new generation, old job purged", async (t) => {
  const { fake, store, hands } = await setup(t);
  fake.mode = "fail-placement";
  const provider = hands(store, { retryFailedAfterMs: 0 });
  await assert.rejects(provider.ensure("alice", "c1"), /placement failed/);
  assert.equal((await read(store, "alice", "c1")).hands?.generation, 1);
  fake.mode = "gate";
  const pending = provider.ensure("alice", "c1");
  const key = handsKey("alice", "c1");
  await until(() => fake.created.includes(`hands-${key}-g2`) && fake.allocPolls > 0, "retry");
  fake.release(`hands-${key}-g2`);
  const b = await pending;
  assert.equal(b.state, "ready");
  assert.equal(b.generation, 2);
  assert.ok(!("retryOf" in b));
});

test("withResources overrides memory, CPU and the inner docker tmpfs, keeping cpu_hard_limit", () => {
  const job = (
    HandsJobTemplate.load().withResources({
      memoryMB: 2048,
      cpuMHz: 3000,
      dockerTmpfsMB: 1024,
    }) as unknown as { job: unknown }
  ).job as {
    TaskGroups: Array<{
      Tasks: Array<{ Resources: Record<string, unknown>; Config: Record<string, any> }>;
    }>;
  };
  const task = job.TaskGroups[0]!.Tasks[0]!;
  assert.equal(task.Resources.MemoryMB, 2048);
  assert.equal(task.Resources.CPU, 3000);
  assert.equal(task.Config.cpu_hard_limit, true);
  assert.equal(task.Config.mount[0].tmpfs_options[0].size, 1024 * 1024 * 1024);
});

test("idle reaper: stops an idle ready sandbox, never a busy one; next ensure starts a new generation", async (t) => {
  const { IdleReaper, StopOnIdle, parseDuration } = await import("./idle.ts");
  assert.equal(parseDuration("15m"), 900_000);
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration(undefined), 0);
  const { fake, store, hands } = await setup(t);
  const provider = hands(store);
  await store.create(initial("c2", "alice"));
  const key1 = handsKey("alice", "c1"),
    key2 = handsKey("alice", "c2");
  fake.mode = "gate";
  const p1 = provider.ensure("alice", "c1"),
    p2 = provider.ensure("alice", "c2");
  await until(() => fake.created.length === 2 && fake.allocPolls > 0, "both registered");
  fake.release(`hands-${key1}-g1`);
  fake.release(`hands-${key2}-g1`);
  await Promise.all([p1, p2]);
  // c2 has a running turn: it must survive however long it has been quiet.
  await store.mutate("alice", "c2", (c) => {
    c.jobs.push({ id: "j1", kind: "prompt", status: "running" } as (typeof c.jobs)[number]);
  });
  const reaper = new IdleReaper(store, () => ["alice"], new StopOnIdle(provider), 30);
  assert.equal(await reaper.sweep(), 0, "nothing is idle yet");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await reaper.sweep(), 1);
  assert.equal((await read(store, "alice", "c1")).hands?.state, "stopped");
  assert.equal((await read(store, "alice", "c2")).hands?.state, "ready", "busy sandbox kept");
  assert.ok(!fake.jobs.has(`hands-${key1}-g1`), "idle job purged");
  // Activity resumes: a fresh generation, transparently.
  const p3 = provider.ensure("alice", "c1");
  await until(() => fake.created.includes(`hands-${key1}-g2`) && fake.allocPolls > 0, "g2");
  fake.release(`hands-${key1}-g2`);
  assert.equal((await p3).generation, 2);
});

test("read window is cut in the sandbox (sed); bash timeout maps to a capped deadline", async () => {
  const { sandboxArgv, bashDeadlineMs, BASH_TIMEOUT_MAX_S } = await import("./hands.ts");
  assert.deepEqual(sandboxArgv("read", { path: "a.txt" }).argv, ["cat", "--", "/workspace/a.txt"]);
  assert.deepEqual(sandboxArgv("read", { path: "a.txt", offset: 3, limit: 2 }).argv, [
    "sed",
    "-n",
    "3,4p",
    "--",
    "/workspace/a.txt",
  ]);
  assert.deepEqual(sandboxArgv("read", { path: "a.txt", offset: 5 }).argv, [
    "sed",
    "-n",
    "5,$p",
    "--",
    "/workspace/a.txt",
  ]);
  assert.deepEqual(sandboxArgv("read", { path: "a.txt", limit: 10 }).argv, [
    "sed",
    "-n",
    "1,10p",
    "--",
    "/workspace/a.txt",
  ]);
  assert.equal(bashDeadlineMs(undefined), 120_000);
  assert.equal(bashDeadlineMs(30), 30_000);
  assert.equal(bashDeadlineMs(99_999), BASH_TIMEOUT_MAX_S * 1000);
  assert.equal(bashDeadlineMs(-1), 120_000);
});

test("afterReady runs once per generation before ensure returns; claimIdle/unclaimIdle round-trip", async (t) => {
  const { fake, store, hands } = await setup(t);
  const seen: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const provider = hands(store, {
    afterReady: async (_o, _i, b) => {
      seen.push(b.generation);
      await gate;
    },
  });
  const key = handsKey("alice", "c1");
  fake.mode = "gate";
  const p1 = provider.ensure("alice", "c1");
  await until(() => fake.created.length === 1 && fake.allocPolls > 0, "registered");
  fake.release(`hands-${key}-g1`);
  await until(() => seen.length === 1, "hook started");
  const p2 = provider.ensure("alice", "c1");
  let settled = false;
  void Promise.all([p1, p2]).then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, "callers wait for the hook (restore) to finish");
  release();
  await Promise.all([p1, p2]);
  await provider.ensure("alice", "c1");
  assert.deepEqual(seen, [1], "once per generation");
  await new Promise((r) => setTimeout(r, 5));
  const claimed = await provider.claimIdle("alice", "c1", 1);
  assert.equal(claimed?.state, "stopping");
  assert.equal(await provider.claimIdle("alice", "c1", 1), null, "claimed once");
  await provider.unclaimIdle("alice", "c1", 1);
  assert.equal((await read(store, "alice", "c1")).hands?.state, "ready");
});
