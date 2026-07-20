import { defineConfig } from "vite";
import crossOriginIsolation from "vite-plugin-cross-origin-isolation";

export default defineConfig({
  // Relative base so the build works under any path, incl. the GitHub Pages
  // project sub-path (https://<user>.github.io/Local-TTS-Demo/). Dev stays at root.
  base: "./",
  plugins: [crossOriginIsolation()],
  server: {
    // Default stays 5173; PORT lets a second dev server run alongside the first.
    port: Number(process.env.PORT) || 5173,
    open: false,
  },
  worker: {
    // ES module format required for code-splitting builds (iife is incompatible).
    format: "es",
  },
  build: {
    target: "esnext",
  },
});
