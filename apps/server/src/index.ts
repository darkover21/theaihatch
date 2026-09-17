import Fastify from "fastify";
import { registerWorkspaceRoutes, type WorkspaceEventSink, WorkspaceRegistry } from "./routes/workspaces.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerInboundMcp } from "./mcp/inbound-controller.js";
import { initializeFirstRun } from "./bootstrap/first-run.js";
import { findLoopbackPort, openBrowser } from "./bootstrap/listen.js";
import { KeytarKeychain } from "./secrets/keychain.js";
import { createMcpToken } from "@theaihatch/mcp-server";

export function createServer(eventSink?: WorkspaceEventSink, mcpToken?: string) {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ ok: true, phase: 2 }));
  const registry = registerWorkspaceRoutes(app, new WorkspaceRegistry(eventSink));
  registerAgentRoutes(app, registry);
  registerInboundMcp(app, registry, mcpToken);
  app.decorate("workspaceRegistry", registry);
  return app;
}

if (process.env.NODE_ENV !== "test") {
  await initializeFirstRun();
  const keychain = new KeytarKeychain();
  const storedMcpToken = await keychain.get("mcp:bearer");
  const mcpToken = storedMcpToken ?? createMcpToken();
  if (storedMcpToken === null) await keychain.set("mcp:bearer", mcpToken);
  const port = await findLoopbackPort(Number(process.env.PORT ?? 4317));
  const host = "127.0.0.1";
  const app = createServer(undefined, mcpToken);
  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await app.listen({ host, port });
  const url = `http://${host}:${port}`;
  console.log(`theaihatch ready at ${url}`);
  if (process.env.THEAIHATCH_AUTO_OPEN === "1") await openBrowser(url);
}
