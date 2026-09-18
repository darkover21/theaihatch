import { startServer } from "./bootstrap/start.js";

export { createServer } from "./app.js";

if (process.env.NODE_ENV !== "test") {
  const server = await startServer({
    preferredPort: Number(process.env.PORT ?? 4317),
    autoOpen: process.env.THEAIHATCH_AUTO_OPEN === "1",
  });
  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  console.log(`theaihatch ready at ${server.url}`);
}
