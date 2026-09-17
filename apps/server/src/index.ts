import Fastify from "fastify";
import { registerWorkspaceRoutes, type WorkspaceEventSink, WorkspaceRegistry } from "./routes/workspaces.js";

export function createServer(eventSink?: WorkspaceEventSink) {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ ok: true, phase: 2 }));
  const registry = registerWorkspaceRoutes(app, new WorkspaceRegistry(eventSink));
  app.decorate("workspaceRegistry", registry);
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 4317);
  const host = "127.0.0.1";
  const app = createServer();
  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await app.listen({ host, port });
}
