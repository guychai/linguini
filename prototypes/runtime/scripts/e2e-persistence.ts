/**
 * End-to-end check of workspace persistence on a node (run as the service user with the service
 * env; see infra/hosting/README.md). Uses its own conversation (id from argv), never others:
 * 1. ensure a sandbox, write files into /workspace, start Postgres in the inner Docker with a
 *    named volume and insert a row; 2. suspend (idle 0) -> snapshot uploaded, sandbox stopped;
 * 3. ensure again (new generation; restore runs) -> files and the database row are back.
 * Prints evidence only, never credentials. The caller deletes the conversation afterwards.
 */
import { readFile } from "node:fs/promises";
import { PostgresStore, initial, read } from "../src/store.ts";
import {
  CommandNetworkProvisioner,
  FileEgressPolicyWriter,
  HandsJobTemplate,
  NomadCliTransport,
  NomadHttpApi,
  NomadKataHands,
  type EgressRule,
} from "../src/hands.ts";
import {
  NomadStreamExec,
  S3SandboxSuspender,
  S3SnapshotStore,
  snapshotKey,
} from "../src/persistence.ts";
import { S3Client } from "../src/s3.ts";

const id = process.argv[2];
const owner = process.env.TAILNET_OWNER ?? "local-owner";
if (!id?.startsWith("e2e-persist-")) throw new Error("usage: e2e-persistence.ts e2e-persist-<n>");
const env = process.env;
const store = await PostgresStore.open(env.DATABASE_URL!);
const rules: EgressRule[] = JSON.parse(await readFile(env.EGRESS_DEFAULT_RULES_FILE!, "utf8"));
const nomadEnv = { NOMAD_ADDR: env.NOMAD_ADDR ?? "http://127.0.0.1:4646" };
const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT!,
  bucket: env.S3_BUCKET ?? "linguini-sandboxes",
  accessKeyId: env.S3_ACCESS_KEY_ID!,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
});
let hands!: NomadKataHands;
const suspender = new S3SandboxSuspender(
  {
    claimIdle: (o, i, ms) => hands.claimIdle(o, i, ms),
    unclaimIdle: (o, i, g) => hands.unclaimIdle(o, i, g),
    stop: (o, i) => hands.stop(o, i),
  },
  store,
  new S3SnapshotStore(s3),
  new NomadStreamExec(env.NOMAD_BIN ?? "nomad", nomadEnv),
  { log: (m) => console.log(m) },
);
const transport = new NomadCliTransport(env.NOMAD_BIN ?? "nomad", nomadEnv);
hands = new NomadKataHands(store, new NomadHttpApi(nomadEnv.NOMAD_ADDR), {
  template: HandsJobTemplate.load().withResources({
    memoryMB: Number(env.SANDBOX_MEMORY_MB) || undefined,
    cpuMHz: Number(env.SANDBOX_CPU_MHZ) || undefined,
    dockerTmpfsMB: Number(env.SANDBOX_DOCKER_TMPFS_MB) || undefined,
  }),
  sandbox: {
    network: new CommandNetworkProvisioner(
      env.SANDBOX_NETCTL ? JSON.parse(env.SANDBOX_NETCTL) : undefined,
    ),
    egress: {
      writer: new FileEgressPolicyWriter(env.EGRESS_POLICY_DIR!),
      rules: () => rules,
      caPem: await readFile(env.EGRESS_CA_FILE!, "utf8"),
    },
  },
  transport,
  afterReady: (o, i, b) => suspender.restore(o, i, b),
  stoppingWaitMs: 15 * 60_000,
});
let n = 0;
const sh = async (script: string, deadlineMs = 300_000) => {
  const b = await hands.ensure(owner, id);
  const r = await transport.exec(b, {
    execId: `e2e-${Date.now()}-${n++}`,
    epoch: 0,
    callId: "e2e",
    argv: ["sh", "-c", script],
    deadlineMs,
    outputLimitBytes: 65536,
    generation: b.generation,
  });
  return `${r.stdout}${r.stderr ? `[stderr] ${r.stderr}` : ""}`.trim() + ` (exit ${r.exitCode})`;
};
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
await store.create({ ...initial(id, owner, "e2e persistence test (delete me)") });
console.log(stamp(), "gen", (await hands.ensure(owner, id)).generation);
console.log(
  stamp(),
  "write:",
  await sh(
    `mkdir -p /workspace/app/src && echo "hello $((6*7))" > /workspace/app/src/hello.txt && dd if=/dev/urandom of=/workspace/app/blob.bin bs=1M count=3 2>/dev/null && chmod 640 /workspace/app/src/hello.txt && sha256sum /workspace/app/blob.bin && ls -l /workspace/app/src`,
  ),
);
console.log(
  stamp(),
  "pg:",
  await sh(
    `docker volume create e2e_pgdata >/dev/null && docker run -d --name e2epg -e POSTGRES_PASSWORD=x -v e2e_pgdata:/var/lib/postgresql/data postgres:17-alpine >/dev/null && for i in $(seq 60); do docker exec e2epg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2; docker exec e2epg psql -U postgres -qc "create table t(v text); insert into t values ('survived-' || 42);" && docker exec e2epg psql -U postgres -Atc "select v from t"`,
    600_000,
  ),
);
console.log(
  stamp(),
  "s3 reachable from sandbox?",
  await sh(
    `gw=$(echo "$HTTP_PROXY" | sed "s#http://##; s#:.*##"); echo "direct-gw:$(curl -s -m 8 --noproxy "*" -o /dev/null -w "%{http_code}" http://$gw:8333/)"; echo "proxy-loopback:$(curl -s -m 8 -x "$HTTP_PROXY" -o /dev/null -w "%{http_code}" http://127.0.0.1:8333/)"; echo "proxy-gw:$(curl -s -m 8 -x "$HTTP_PROXY" -o /dev/null -w "%{http_code}" http://$gw:8333/)"`,
  ),
);
console.log(stamp(), "suspend:", await suspender.suspendIfIdle(owner, id, 0));
const head = await s3.head(snapshotKey((await read(store, owner, id)).hands!.workspaceId));
console.log(stamp(), "object:", head);
console.log(stamp(), "state:", (await read(store, owner, id)).hands?.state);
const b2 = await hands.ensure(owner, id);
console.log(stamp(), "gen", b2.generation, "(restore ran in afterReady)");
console.log(
  stamp(),
  "files:",
  await sh(
    `cat /workspace/app/src/hello.txt; sha256sum /workspace/app/blob.bin; ls -l /workspace/app/src; ls /workspace`,
  ),
);
console.log(
  stamp(),
  "pg after:",
  await sh(
    `docker volume ls -q; docker run -d --name e2epg2 -e POSTGRES_PASSWORD=x -v e2e_pgdata:/var/lib/postgresql/data postgres:17-alpine >/dev/null && for i in $(seq 60); do docker exec e2epg2 pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2; docker exec e2epg2 psql -U postgres -Atc "select v from t"`,
    600_000,
  ),
);
console.log(
  stamp(),
  "events:",
  (await read(store, owner, id)).events
    .filter((e) => e.type.startsWith("workspace."))
    .map((e) => `${e.type} ${JSON.stringify(e.data)}`),
);
await hands.stop(owner, id);
await s3.delete(snapshotKey(b2.workspaceId));
console.log(stamp(), "cleanup: sandbox stopped, object deleted");
await store.close();
process.exit(0);
