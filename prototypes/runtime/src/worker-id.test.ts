import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { workerId } from "./worker-id.ts";

test("default worker ID is hostname:port:<random>, unique per process; OWN_WORKER_ID overrides", () => {
  const env = { OWN_PORT: "43299" };
  const a = workerId(env),
    b = workerId(env);
  assert.match(
    a,
    new RegExp(`^${hostname().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:43299:[0-9a-f-]{12}$`),
  );
  assert.notEqual(a, b, "two processes on the same host and port never share a worker ID");
  assert.equal(workerId({ OWN_WORKER_ID: "slot-7", OWN_PORT: "1" }), "slot-7");
});
