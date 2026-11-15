// External links in generated content open the click-through page (full URL shown there).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clickThroughHref, isExternalGeneratedHref } from "../../web/src/lib/externalLinks.ts";
import {
  clickThroughLink,
  CLICK_THROUGH_TITLE,
} from "../../web/src/components/chat/linguiniGeneratedLinks.tsx";

test("only http(s) and protocol-relative links count as external", () => {
  for (const h of ["https://x/y", "http://x", "HTTPS://X", "//cdn.example/a", " https://x "])
    assert.equal(isExternalGeneratedHref(h), true, h);
  for (const h of ["/workspace/a.ts", "a.ts", "#frag", "", undefined, null, "mailto:a@b"])
    assert.equal(isExternalGeneratedHref(h), false, String(h));
});

test("click-through href carries the full URL, encoded; protocol-relative becomes https", () => {
  assert.equal(
    clickThroughHref("https://evil.example/leak?d=4711&x=#y"),
    `/out?u=${encodeURIComponent("https://evil.example/leak?d=4711&x=#y")}`,
  );
  assert.equal(
    clickThroughHref("//cdn.example/a"),
    `/out?u=${encodeURIComponent("https://cdn.example/a")}`,
  );
});

test("rendering: external links point at /out with no referrer; in-app links render normally", () => {
  const el = clickThroughLink(true, "https://evil.example/leak?d=4711", "click me");
  assert.ok(el);
  const html = renderToStaticMarkup(createElement("div", null, el));
  assert.match(html, /data-linguini-external-link/);
  assert.match(html, /href="\/out\?u=https%3A%2F%2Fevil\.example%2Fleak%3Fd%3D4711"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.ok(html.includes(CLICK_THROUGH_TITLE));
  assert.ok(!html.includes('href="https://'), "never a direct external href");
  assert.equal(clickThroughLink(false, "https://x", "x"), null, "non-Linguini build");
  assert.equal(clickThroughLink(true, "/workspace/a.ts", "a.ts"), null, "in-app link");
  assert.equal(clickThroughLink(true, undefined, "x"), null);
});
