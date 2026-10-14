// Browser destinations are independent of remote sandbox egress policy.
// 'wasm-unsafe-eval' allows compiling WebAssembly (the Ghostty terminal renderer) only, not JS eval.
/**
 * The app's CSP for one request: frames only from this host's /render/ path (visual replies,
 * themselves sandboxed by RENDER_CSP), nothing else. The host comes from the request's own Host
 * header (character-checked), so it is right behind Tailscale serve too.
 */
export function appCsp(host: string | undefined, renders: boolean): string {
  const h = host && /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host) ? host : undefined;
  return renders && h
    ? browserCsp.replace("frame-src 'none'", `frame-src ${h}/render/`)
    : browserCsp;
}
export const browserCsp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
