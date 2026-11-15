// Child process for durable-harness.test.ts: starts a Durable turn whose non-idempotent host
// tool never returns, then exits mid-call like a crashed worker.
import pg from "pg";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { DurableHarness, DurableStore } from "./durable-harness.ts";
import { HostToolRegistry } from "./host-tools.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import { PostgresStore, initial } from "./store.ts";

const [owner, id] = [process.argv[2]!, process.argv[3]!];
const store = await PostgresStore.open(process.env.TEST_DATABASE_URL!);
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 2 });
await store.create(initial(id, owner));
const broker = new SandboxBroker(store, new FixtureSandbox(), {
  hostTools: new HostToolRegistry({
    publish: {
      policy: { replay: "non-idempotent", destination: "sandbox", egress: false },
      writes: ["github"],
      destinations: () => [],
      handler: async () => {
        console.log("crashing");
        process.exit(0);
      },
      description: "Publish to a repo",
      parameters: { type: "object", properties: { repo: { type: "string" } } },
    },
  }),
});
const f = fauxProvider({ tokensPerSecond: 100_000 });
const models = createModels();
models.setProvider(f.provider);
f.setResponses([
  fauxAssistantMessage([fauxToolCall("publish", { repo: "acme/app" })], { stopReason: "toolUse" }),
]);
const h = await DurableHarness.create({
  broker,
  owner,
  id,
  jobId: "first",
  store: new DurableStore(pool),
  models,
  model: { provider: "faux", modelId: f.getModel().id },
  systemPrompt: "test",
});
await h.run("go", "", async () => undefined, new AbortController().signal);
