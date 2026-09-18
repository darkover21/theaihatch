import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AssetProvider } from "../src/bootstrap/assets.js";
import { startServer } from "../src/bootstrap/start.js";
import type { Keychain } from "../src/secrets/keychain.js";

describe("server startup", () => {
  it("initializes, creates one MCP token, binds, becomes ready, opens, and closes in order", async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-start-"));
    const events: string[] = [];
    let storedToken: string | null = null;
    let createdWithToken: string | undefined;
    let createdWithAssets: AssetProvider | undefined;
    const assetProvider: AssetProvider = { read: async () => null };
    const keychain: Keychain = {
      async get(account) {
        const state = JSON.parse(await fs.readFile(path.join(dataDirectory, "first-run.json"), "utf8")) as { initialized: boolean };
        expect(state.initialized).toBe(true);
        expect(account).toBe("mcp:bearer");
        events.push("first-run", "token:get");
        return null;
      },
      async set(account, value) {
        expect(account).toBe("mcp:bearer");
        storedToken = value;
        events.push("token:set");
      },
      async delete() {},
    };

    const server = await startServer({
      dataDirectory,
      preferredPort: 0,
      fallbackCount: 5,
      autoOpen: true,
      assetProvider,
      keychain,
      createApp(mcpToken, assets) {
        createdWithToken = mcpToken;
        createdWithAssets = assets;
        events.push("create");
        const app = Fastify();
        app.get("/health", async () => ({ ok: true }));
        app.addHook("onListen", async () => {
          events.push("bind");
        });
        return app;
      },
      async readiness(url) {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
        expect((await fetch(`${url}/health`)).status).toBe(200);
        events.push("readiness");
      },
      async browserOpener(url) {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
        events.push("browser");
      },
    });

    try {
      expect(events).toEqual(["first-run", "token:get", "token:set", "create", "bind", "readiness", "browser"]);
      expect(storedToken).toBeTruthy();
      expect(createdWithToken).toBe(storedToken);
      expect(createdWithAssets).toBe(assetProvider);
      expect(server.host).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toBe(`http://${server.host}:${server.port}`);
      expect(server.app.server.listening).toBe(true);
    } finally {
      await server.close();
      await fs.rm(dataDirectory, { recursive: true });
    }

    expect(server.app.server.listening).toBe(false);
  });

  it("does not make an otherwise ready server depend on browser availability", async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-browser-"));

    const server = await startServer({
      dataDirectory,
      preferredPort: 0,
      autoOpen: true,
      keychain: {
        async get() { return "stored-token"; },
        async set() { throw new Error("must not replace a stored token"); },
        async delete() {},
      },
      createApp() {
        const app = Fastify();
        app.get("/health", async () => ({ ok: true }));
        return app;
      },
      async readiness() {},
      async browserOpener() {
        throw new Error("no browser installed");
      },
    });

    await server.close();
    await fs.rm(dataDirectory, { recursive: true });
  });
});
