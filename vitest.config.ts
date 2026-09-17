import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@theaihatch/ses/browser": path.resolve("packages/ses/src/browser.ts"),
      "@theaihatch/ses": path.resolve("packages/ses/src/index.ts"),
      "@theaihatch/playback": path.resolve("packages/playback/src/index.ts"),
      "@theaihatch/typing-sim": path.resolve("packages/typing-sim/src/index.ts"),
      "@theaihatch/storage": path.resolve("packages/storage/src/index.ts"),
      "@theaihatch/workspace": path.resolve("packages/workspace/src/index.ts"),
      "@theaihatch/providers": path.resolve("packages/providers/src/index.ts"),
      "@theaihatch/agent": path.resolve("packages/agent/src/index.ts"),
      "@theaihatch/mcp-client": path.resolve("packages/mcp-client/src/index.ts"),
      "@theaihatch/mcp-server": path.resolve("packages/mcp-server/src/index.ts"),
      "@theaihatch/safety": path.resolve("packages/safety/src/index.ts"),
      "@theaihatch/review": path.resolve("packages/review/src/index.ts"),
      "@theaihatch/packaging": path.resolve("packages/packaging/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"]
  }
});
