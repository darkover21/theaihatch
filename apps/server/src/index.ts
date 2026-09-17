import Fastify from "fastify";

export function createServer() {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ ok: true, phase: 1 }));
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 4317);
  const host = "127.0.0.1";
  const app = createServer();
  await app.listen({ host, port });
}
