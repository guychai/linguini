import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default {
  plugins: [{ name: "owned-session-boundary", enforce: "pre" as const, resolveId(source: string, importer?: string) {
      if (importer?.replaceAll("\\", "/").endsWith("/client-runtime/src/connection/layer.ts") && source === "../rpc/session.ts") return fileURLToPath(new URL("./src/t3-adapter.ts", import.meta.url));
    } }, react(), babel({ parserOpts: { plugins: ["typescript", "jsx"] }, presets: [reactCompilerPreset()] }), tailwindcss()],
  define: { "import.meta.env.APP_VERSION": JSON.stringify("0.0.14"), "import.meta.env.VITE_SANDBOX_BOUNDARY": JSON.stringify("1") },
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("../web/src", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 43221,
    strictPort: true,
    proxy: {
      "/api": process.env.OWN_BACKEND_URL ?? "http://127.0.0.1:43220",
      "/.well-known": process.env.OWN_BACKEND_URL ?? "http://127.0.0.1:43220",
      "/health": process.env.OWN_BACKEND_URL ?? "http://127.0.0.1:43220",
    },
  },
};
