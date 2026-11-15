// Child process for durable-harness.test.ts: starts a Durable turn whose non-idempotent host
// tool never returns, then exits mid-call like a crashed worker.
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { DurableHarness, DurableStore } from "./durable-harness.ts";
import { HostToolRegistry } from "./host-tools.ts";
import { FixtureSandbox, SandboxBroker } from "./sandbox.ts";
import { SqliteStore, initial } from "./store.ts";

const dir = process.argv[2]!;
const store = new SqliteStore(join(dir, "state.sqlite"));
await store.create(initial("c", "alice"));
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
  owner: "alice",
  id: "c",
  jobId: "first",
  store: new DurableStore(join(dir, "durable")),
  models,
  model: { provider: "faux", modelId: f.getModel().id },
  systemPrompt: "test",
});
await h.run("go", "", async () => undefined, new AbortController().signal);
