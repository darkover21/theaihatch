import Fastify, { type FastifyInstance } from "fastify";
import { RunCoordinator } from "./agent/run-coordinator.js";
import { registerWebAssets, type AssetProvider } from "./bootstrap/assets.js";
import { registerInboundMcp } from "./mcp/inbound-controller.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerWorkspaceRoutes, type WorkspaceEventSink, WorkspaceRegistry } from "./routes/workspaces.js";

export function createServer(eventSink?: WorkspaceEventSink, mcpToken?: string, assetProvider?: AssetProvider): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ ok: true, phase: 2 }));
  const registry = registerWorkspaceRoutes(app, new WorkspaceRegistry(eventSink));
  const runCoordinator = new RunCoordinator();
  registerAgentRoutes(app, registry, undefined, runCoordinator);
  registerInboundMcp(app, registry, mcpToken);
  if (assetProvider !== undefined) registerWebAssets(app, assetProvider);
  app.decorate("workspaceRegistry", registry);
  app.decorate("runCoordinator", runCoordinator);
  return app;
}
