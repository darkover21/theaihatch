import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve("apps/web"),
  plugins: [react()],
  resolve: {
    alias: {
      "@theaihatch/ses/browser": path.resolve("packages/ses/src/browser.ts"),
      "@theaihatch/ses": path.resolve("packages/ses/src/browser.ts"),
      "@theaihatch/playback": path.resolve("packages/playback/src/index.ts"),
      "@theaihatch/typing-sim": path.resolve("packages/typing-sim/src/index.ts")
    }
  },
  build: {
    outDir: path.resolve("apps/web/dist"),
    emptyOutDir: true
  },
  server: {
    host: true,
    fs: {
      allow: [path.resolve(".")]
    }
  }
});
