// Test-only backend for the "outcome unknown" browser test: own-main's API, engine, recovery
// and sweeper, with the fake external destination instead of a sandbox. A prompt containing
// "edit" issues one non-idempotent edit; anything else issues a safe read. LEDGER_KILL_AT
// SIGKILLs the process at that ledger boundary. Never used in production.
import { resolve } from "node:path";
import { PostgresStore } from "./store.ts";
import { SandboxBroker, type LedgerBoundary } from "./sandbox.ts";
import { Engine } from "./engine.ts";
import { api, type TokenBindings } from "./api.ts";
import type { Fence } from "./store.ts";
import type { Harness, Sink } from "./harness.ts";
import {
  FakeDestination,
  LEDGER_CALLS,
  LEDGER_TEST_POLICIES,
  ScriptedHarness,
} from "./ledger-fixtures.ts";

const env = process.env;
const store = await PostgresStore.open(env.DATABASE_URL!);
const bindings = JSON.parse(env.OWNER_TOKENS!) as TokenBindings;
const killAt = env.LEDGER_KILL_AT as LedgerBoundary | undefined;
const broker = new SandboxBroker(store, new FakeDestination(env.LEDGER_DEST!), {
  policies: LEDGER_TEST_POLICIES,
  fault: (at) => {
    if (at === killAt) process.kill(process.pid, "SIGKILL");
  },
});
class PromptHarness implements Harness {
  constructor(
    private owner: string,
    private id: string,
    private jobId: string,
    private fence?: Fence,
  ) {}
  async run(text: string, history: string, emit: Sink, signal: AbortSignal) {
    const call = text.includes("edit") ? LEDGER_CALLS["non-idempotent"] : LEDGER_CALLS["safe-read"];
    await new ScriptedHarness(broker, this.owner, this.id, this.jobId, this.fence, call).run(
      text,
      history,
      emit,
      signal,
    );
    await emit("assistant.delta", { text: `Ledger fixture finished: ${text}` });
  }
  async steer() {}
  async abort() {}
  dispose() {}
}
const leaseMs = Number(env.OWN_LEASE_MS ?? 1_000);
const engine = new Engine(store, async (o, i, j, f) => new PromptHarness(o, i, j, f), {
  leaseMs,
  recoverTools: (o, i, f) => broker.recover(o, i, f),
});
const owners = new Set(Object.values(bindings));
for (const owner of owners) await engine.recover(owner);
const sweeper = setInterval(() => {
  for (const owner of owners) void engine.sweep(owner).catch(() => undefined);
}, leaseMs);
const { server, closeStreams } = api(engine, bindings, resolve(env.OWN_WEB_DIST!));
server.listen(Number(env.OWN_PORT), "127.0.0.1");
process.once("SIGTERM", () => {
  closeStreams();
  server.close();
  clearInterval(sweeper);
  void engine.stop().then(() => store.close());
});
