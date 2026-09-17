import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  use: { baseURL: "http://[::1]:5173" },
  webServer: {
    command: "npm run dev",
    url: "http://[::1]:5173",
    reuseExistingServer: true
  }
});
