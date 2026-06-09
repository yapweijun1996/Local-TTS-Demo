import { defineConfig } from "vite";
import crossOriginIsolation from "vite-plugin-cross-origin-isolation";

export default defineConfig({
  // Relative base so the build works under any path, incl. the GitHub Pages
  // project sub-path (https://<user>.github.io/Local-TTS-Demo/). Dev stays at root.
  base: "./",
  plugins: [crossOriginIsolation()],
  server: {
    port: 5173,
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
