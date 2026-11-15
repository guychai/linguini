// External links in generated content go through Linguini's click-through page (`/out`, served
// by prototypes/runtime/src/out.ts), which shows the full URL before the user leaves the app.
// No import.meta here: node tests import it.

/** The click-through route; must match prototypes/runtime/src/out.ts. */
export const CLICK_THROUGH_PATH = "/out";

/**
 * Links that would leave the app: http(s) or protocol-relative. In-app links (thread links, file
 * links, relative paths, fragments) are not rewritten; other schemes are already dropped by
 * safeGeneratedLink (prototypeContentPolicy.ts).
 */
export function isExternalGeneratedHref(href: string | undefined | null): href is string {
  if (!href) return false;
  const h = href.trim();
  return /^https?:\/\//i.test(h) || h.startsWith("//");
}

/** The in-app click-through URL for an external link. */
export function clickThroughHref(href: string): string {
  const h = href.trim();
  const absolute = h.startsWith("//") ? `https:${h}` : h;
  return `${CLICK_THROUGH_PATH}?u=${encodeURIComponent(absolute)}`;
}
