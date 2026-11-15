// Which threads have read sensitive data, as far as this browser knows. The owned web UI feeds it
// from every conversation it projects (apps/owned-web/src/projection.ts); markdown rendering reads
// it so a sensitive thread's links render as inert text (linguiniGeneratedLinks.tsx). No
// import.meta here: node tests import it.
const sensitive = new Set<string>();
const listeners = new Set<() => void>();

/** Sensitivity only ever turns on for a thread (taint is permanent), so a stale false is harmless. */
export function setGeneratedContentTainted(threadId: string, tainted: boolean) {
  if (!tainted || sensitive.has(threadId)) return;
  sensitive.add(threadId);
  for (const listener of listeners) listener();
}
export function isGeneratedContentTainted(threadId: string | undefined | null): boolean {
  return !!threadId && sensitive.has(threadId);
}
export function subscribeGeneratedContentTaint(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
/**
 * Links that would leave the app: any scheme (http, https, mailto, …) or protocol-relative.
 * In-app links (thread links, file links, relative paths, fragments) are not inerted.
 */
export function isExternalGeneratedHref(href: string | undefined | null): href is string {
  if (!href) return false;
  const h = href.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//");
}
/** What an inert link shows: its text, plus the full URL when the text is not already the URL. */
export function inertLinkLabel(text: string, href: string) {
  const t = text.trim();
  return !t || t === href.trim() ? { text: href, url: null } : { text: t, url: href };
}
