import { initializeFirstRun } from "./bootstrap/first-run.js";
import { findLoopbackPort, openBrowser } from "./bootstrap/listen.js";
import { KeytarKeychain } from "./secrets/keychain.js";
import { createMcpToken } from "@theaihatch/mcp-server";
import { createServer } from "./app.js";

export { createServer } from "./app.js";

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
