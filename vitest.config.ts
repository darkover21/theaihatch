import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@theaihatch/ses/browser": path.resolve("packages/ses/src/browser.ts"),
      "@theaihatch/ses": path.resolve("packages/ses/src/index.ts"),
      "@theaihatch/playback": path.resolve("packages/playback/src/index.ts"),
      "@theaihatch/typing-sim": path.resolve("packages/typing-sim/src/index.ts"),
      "@theaihatch/storage": path.resolve("packages/storage/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts"]
  }
});
