// Visual replies: upstream's HtmlRenderFrame asks `assets.createUrl` for its page. Only html
// render attachments exist in the owned backend; it mints a short-lived signed URL for the
// signed-in owner's own page (POST /api/renders/url), served with the render sandbox CSP.
export type RenderRequest = (path: string, data?: unknown) => Promise<Response>;

export async function renderAssetUrl(
  resource: unknown,
  request: RenderRequest,
): Promise<{ relativeUrl: string; expiresAt: number }> {
  const r = resource as { _tag?: unknown; attachmentId?: unknown } | null;
  if (
    !r ||
    r._tag !== "attachment" ||
    typeof r.attachmentId !== "string" ||
    !/^[a-f0-9]{32}-html$/.test(r.attachmentId)
  )
    throw new Error("Only visual reply pages are available in this environment");
  const response = await request("/api/renders/url", { attachmentId: r.attachmentId });
  const value = (await response.json()) as { relativeUrl?: unknown; expiresAt?: unknown };
  if (
    typeof value.relativeUrl !== "string" ||
    !value.relativeUrl.startsWith("/render/") ||
    typeof value.expiresAt !== "number"
  )
    throw new Error("Unexpected render URL");
  return { relativeUrl: value.relativeUrl, expiresAt: value.expiresAt };
}
