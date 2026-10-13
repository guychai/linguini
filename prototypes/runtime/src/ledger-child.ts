// Child process for the tool-ledger kill tests: runs one job whose single tool call is
// SIGKILLed at the requested ledger boundary. Test support only.
import { randomUUID } from "node:crypto";
import { PostgresStore, SqliteStore, type Store } from "./store.ts";
import { SandboxBroker, type LedgerBoundary } from "./sandbox.ts";
import { Engine } from "./engine.ts";
import {
  FakeDestination,
  LEDGER_CALLS,
  LEDGER_TEST_POLICIES,
  ScriptedHarness,
} from "./ledger-fixtures.ts";

const env = process.env;
const store: Store =
  env.LEDGER_BACKEND === "postgres"
    ? await PostgresStore.open(env.LEDGER_STORE!, { listen: false })
    : new SqliteStore(env.LEDGER_STORE!);
const destination = new FakeDestination(env.LEDGER_DEST!);
const boundary = env.LEDGER_BOUNDARY as LedgerBoundary;
const call = LEDGER_CALLS[env.LEDGER_CLASS as keyof typeof LEDGER_CALLS];
const broker = new SandboxBroker(store, destination, {
  policies: LEDGER_TEST_POLICIES,
  fault: (at) => {
    if (at === boundary) process.kill(process.pid, "SIGKILL");
  },
});
const engine = new Engine(
  store,
  async (owner, id, jobId, fence) => new ScriptedHarness(broker, owner, id, jobId, fence, call),
  { worker: `child-${randomUUID()}`, leaseMs: 60_000, heartbeatMs: 0 },
);
const owner = env.LEDGER_OWNER!,
  id = env.LEDGER_CONVERSATION!;
await engine.command(owner, id, { commandId: "first", kind: "prompt", text: "run the tool" });
await new Promise((r) => setTimeout(r, 50));
await engine.idle(owner, id);
// Reaching here means the boundary never fired.
process.exit(3);
