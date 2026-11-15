// Linguini: in a thread that has read sensitive data, links in rendered markdown are inert text
// with the full URL visible (no <a href>, no favicon fetch, no click-through). Clean threads keep
// upstream's links. Hooked from ChatMarkdown's anchor renderer; the logic lives here.
import { useCallback, useSyncExternalStore } from "react";
import { restrictGeneratedContent } from "../../lib/prototypeContentPolicy";
import {
  inertLinkLabel,
  isExternalGeneratedHref,
  isGeneratedContentTainted,
  subscribeGeneratedContentTaint,
} from "../../lib/generatedContentTaint";

export const INERT_LINK_TITLE =
  "Links are disabled in this conversation because it has read sensitive data";

export function useInertGeneratedLinks(threadId: string | undefined): boolean {
  const get = useCallback(
    () => restrictGeneratedContent && isGeneratedContentTainted(threadId),
    [threadId],
  );
  return useSyncExternalStore(subscribeGeneratedContentTaint, get, get);
}

/** The inert replacement for an external link, or null to render the link normally. */
export function inertGeneratedLink(inert: boolean, href: string | undefined, text: string) {
  if (!inert || !isExternalGeneratedHref(href)) return null;
  const label = inertLinkLabel(text, href);
  return (
    <span data-linguini-inert-link="" title={INERT_LINK_TITLE} className="break-all">
      {label.text}
      {label.url ? <span className="text-muted-foreground"> ({label.url})</span> : null}
    </span>
  );
}
