import assert from "node:assert/strict";
import { test } from "node:test";
import { withClientHeader } from "./client-header.ts";

test("adds X-Linguini-Client only to same-origin /api requests, keeping other headers", async () => {
  const seen: [string, Headers][] = [];
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push([String(input), new Headers(init?.headers)]);
    return new Response(null);
  }) as typeof fetch;
  const f = withClientHeader(base, "https://app.example");
  await f("/api/conversations", { headers: { authorization: "Bearer x" } });
  await f("https://app.example/api/auth/sign-in/email", { method: "POST" });
  await f("/assets/a.js");
  await f("https://other.example/api/x");
  assert.equal(seen[0]![1].get("x-linguini-client"), "1");
  assert.equal(seen[0]![1].get("authorization"), "Bearer x");
  assert.equal(seen[1]![1].get("x-linguini-client"), "1");
  assert.equal(seen[2]![1].get("x-linguini-client"), null);
  assert.equal(seen[3]![1].get("x-linguini-client"), null);
});
