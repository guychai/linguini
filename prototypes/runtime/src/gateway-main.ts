import { gateway } from "./gateway.ts";
import { SqliteStore } from "./store.ts";
import { FixtureSandbox, RemoteSandbox, SandboxBroker } from "./sandbox.ts";

const key = process.env.T3_SANDBOX_KEY;
if (!key) throw new Error("Set T3_SANDBOX_KEY (do not commit it)");
const provider =
  process.env.SANDBOX_PROVIDER === "remote"
    ? new RemoteSandbox(process.env.SANDBOX_URL ?? "", process.env.SANDBOX_TOKEN ?? "")
    : new FixtureSandbox();
const store = new SqliteStore(process.env.SANDBOX_DB ?? ".t3/sandbox.sqlite");
const server = gateway(new SandboxBroker(store, provider), key);
server.listen(Number(process.env.SANDBOX_PORT ?? 43190), "127.0.0.1", () => {
  console.log(`Sandbox gateway ready (${provider.kind})`);
});
process.once("SIGTERM", () =>
  server.close(() => {
    void store.close();
  }),
);
