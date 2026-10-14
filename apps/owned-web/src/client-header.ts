// Imported first by boot.ts, before any module captures globalThis.fetch: every same-origin
// /api request carries X-Linguini-Client, which the backend requires for cookie/tailnet
// sessions (a cross-origin page cannot set it without a CORS preflight).
export const CLIENT_HEADER = "X-Linguini-Client";

export function withClientHeader(base: typeof fetch, origin: string): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return base(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(CLIENT_HEADER, "1");
    return base(input, { ...init, headers });
  };
}

if (typeof location !== "undefined")
  globalThis.fetch = withClientHeader(globalThis.fetch.bind(globalThis), location.origin);
