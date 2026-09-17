import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, "apps/web"),
  plugins: [react()],
  resolve: {
    alias: {
      "@theaihatch/ses/browser": path.join(projectRoot, "packages/ses/src/browser.ts"),
      "@theaihatch/ses": path.join(projectRoot, "packages/ses/src/browser.ts"),
      "@theaihatch/playback": path.join(projectRoot, "packages/playback/src/index.ts"),
      "@theaihatch/typing-sim": path.join(projectRoot, "packages/typing-sim/src/index.ts")
    }
  },
  build: {
    outDir: path.join(projectRoot, "apps/web/dist"),
    emptyOutDir: true
  },
  server: {
    host: true,
    proxy: { "/api": "http://127.0.0.1:4317" },
    fs: {
      allow: [projectRoot]
    }
  }
});
