import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@theaihatch/ses": path.join(projectRoot, "packages/ses/src/index.ts"),
      "@theaihatch/workspace": path.join(projectRoot, "packages/workspace/src/index.ts")
    }
  },
  ssr: { noExternal: true }
});
