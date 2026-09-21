import { createMcpToken } from "@theaihatch/mcp-server";
import type { FastifyInstance } from "fastify";
import { createServer } from "../app.js";
import { KeytarKeychain, type Keychain } from "../secrets/keychain.js";
import type { AssetProvider } from "./assets.js";
import { initializeFirstRun } from "./first-run.js";
import { listenLoopback, openBrowser, waitForReadiness, type ListenOptions } from "./listen.js";

const loopbackHost = "127.0.0.1" as const;

export interface StartServerOptions {
  dataDirectory?: string;
  preferredPort?: number;
  fallbackCount?: number;
  autoOpen?: boolean;
  assetProvider?: AssetProvider;
  keychain?: Keychain;
  createApp?: (mcpToken: string, assetProvider?: AssetProvider, dataDirectory?: string) => FastifyInstance;
  browserOpener?: (url: string) => Promise<void>;
  readiness?: (url: string) => Promise<void>;
}

export interface StartedServer {
  app: FastifyInstance;
  host: "127.0.0.1";
  port: number;
  url: string;
  close(): Promise<void>;
}

/** An explicit token keeps a development or test client reproducible and never touches the keychain. */
async function resolveMcpToken(keychain: Keychain): Promise<string> {
  const override = process.env.THEAIHATCH_MCP_TOKEN;
  if (override !== undefined && override !== "") return override;
  const stored = await keychain.get("mcp:bearer");
  if (stored !== null) return stored;
  const generated = createMcpToken();
  await keychain.set("mcp:bearer", generated);
  return generated;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  if (options.dataDirectory === undefined) await initializeFirstRun();
  else await initializeFirstRun({ dataDirectory: options.dataDirectory });

  const mcpToken = await resolveMcpToken(options.keychain ?? new KeytarKeychain());

  const createApp = options.createApp ?? ((token, assetProvider, dataDirectory) => createServer(undefined, token, assetProvider, dataDirectory));
  const app = createApp(mcpToken, options.assetProvider, options.dataDirectory);
  const listenOptions: ListenOptions = {
    host: loopbackHost,
    preferredPort: options.preferredPort ?? Number(process.env.PORT ?? 4317),
  };
  if (options.fallbackCount !== undefined) listenOptions.fallbackCount = options.fallbackCount;

  try {
    const port = await listenLoopback(app, listenOptions);
    const url = `http://${loopbackHost}:${port}`;
    await (options.readiness ?? waitForReadiness)(url);

    if (options.autoOpen === true) {
      try {
        await (options.browserOpener ?? openBrowser)(url);
      } catch {
        // Browser launch is optional and must not make a ready server fail startup.
      }
    }

    return {
      app,
      host: loopbackHost,
      port,
      url,
      async close() {
        await app.close();
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}
