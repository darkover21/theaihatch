import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  use: { baseURL: "http://[::1]:5173" },
  webServer: [
    { command: "node node_modules/vite-node/vite-node.mjs --config vite.server.config.ts --script apps/server/src/index.ts", url: "http://127.0.0.1:4317/health", reuseExistingServer: true, gracefulShutdown: { signal: "SIGINT", timeout: 1000 } },
    { command: "node node_modules/vite/bin/vite.js --config vite.config.ts", url: "http://[::1]:5173", reuseExistingServer: true, gracefulShutdown: { signal: "SIGINT", timeout: 1000 } }
  ]
});
