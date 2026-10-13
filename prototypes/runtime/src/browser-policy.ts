// Browser destinations are independent of remote sandbox egress policy.
// 'wasm-unsafe-eval' allows compiling WebAssembly (the Ghostty terminal renderer) only, not JS eval.
export const browserCsp =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
