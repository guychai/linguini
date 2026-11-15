// Linguini: external links in rendered markdown open Linguini's click-through page, which shows
// the full URL first (no direct navigation, no favicon fetch, no referrer). Hooked from
// ChatMarkdown's anchor renderer; the logic lives here.
import type { ReactNode } from "react";
import { clickThroughHref, isExternalGeneratedHref } from "../../lib/externalLinks";

export const CLICK_THROUGH_TITLE = "Opens a page that shows the full address before you leave";

/** The click-through replacement for an external link, or null to render the link normally. */
export function clickThroughLink(enabled: boolean, href: string | undefined, children: ReactNode) {
  if (!enabled || !isExternalGeneratedHref(href)) return null;
  return (
    <a
      data-linguini-external-link=""
      href={clickThroughHref(href)}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      title={CLICK_THROUGH_TITLE}
      className="break-words underline"
    >
      {children}
    </a>
  );
}
