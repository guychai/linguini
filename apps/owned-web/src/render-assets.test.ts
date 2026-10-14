import assert from "node:assert/strict";
import test from "node:test";
import { renderAssetUrl } from "./render-assets.ts";

test("mints render URLs only for html render attachments", async () => {
  const calls: Array<[string, unknown]> = [];
  const request = async (path: string, data?: unknown) => {
    calls.push([path, data]);
    return new Response(JSON.stringify({ relativeUrl: "/render/x.html?s=1", expiresAt: 5 }));
  };
  const id = `${"a".repeat(32)}-html`;
  assert.deepEqual(
    await renderAssetUrl({ _tag: "attachment", attachmentId: id, mimeType: "text/html" }, request),
    { relativeUrl: "/render/x.html?s=1", expiresAt: 5 },
  );
  assert.deepEqual(calls, [["/api/renders/url", { attachmentId: id }]]);
  for (const resource of [
    { _tag: "workspace-file", path: "/etc/passwd" },
    { _tag: "attachment", attachmentId: "../x" },
    null,
  ])
    await assert.rejects(renderAssetUrl(resource, request));
  assert.equal(calls.length, 1);
  const bad = async () =>
    new Response(JSON.stringify({ relativeUrl: "https://evil/x", expiresAt: 1 }));
  await assert.rejects(renderAssetUrl({ _tag: "attachment", attachmentId: id }, bad));
});
