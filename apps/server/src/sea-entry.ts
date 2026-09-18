import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadNativePackage } from "../../../packages/packaging/src/runtime.js";
import { createPackagedAssetProvider } from "./bootstrap/assets.js";
import { createBoundedShutdownHandler } from "./bootstrap/shutdown.js";
import { startServer } from "./bootstrap/start.js";
import { MemoryKeychain } from "./secrets/keychain.js";

// The builder executes this mode before publishing a manifest. Exercise the
// shipped server composition and both native modules without user credentials.
async function verifyArtifact(): Promise<void> {
  const Database = loadNativePackage("better-sqlite3");
  const database = new Database(":memory:");
  try {
    if (database.prepare<[], { answer: number }>("SELECT 42 AS answer").get()?.answer !== 42) throw new Error("SQLite verification failed");
  } finally { database.close(); }
  if (typeof loadNativePackage("keytar").getPassword !== "function") throw new Error("Keytar verification failed");
  const assetProvider = await createPackagedAssetProvider();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-verify-"));
  try {
    const server = await startServer({ dataDirectory: directory, preferredPort: 0, autoOpen: false, keychain: new MemoryKeychain(), assetProvider });
    try {
      const response = await fetch(server.url);
      const index = await assetProvider.read("index.html");
      if (!response.ok || !index || await response.text() !== index.body.toString("utf8")) throw new Error("Embedded UI verification failed");
    } finally { await server.close(); }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  console.log(JSON.stringify({ verified: true, sqlite: 42, keytar: true, web: true }));
}

async function main(): Promise<void> {
  if (process.argv.includes("--theaihatch-verify")) return verifyArtifact();
  const assetProvider = await createPackagedAssetProvider();
  const server = await startServer({ assetProvider, autoOpen: process.env.THEAIHATCH_AUTO_OPEN !== "0" });
  const coordinator = server.app.getDecorator<import("./agent/run-coordinator.js").RunCoordinator>("runCoordinator");
  const shutdown = createBoundedShutdownHandler({ coordinator, closeServer: () => server.close() });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  console.log(`theaihatch ready at ${server.url}`);
}

function fail(error: unknown): void {
  console.error(error);
  process.exitCode = 1;
}

void main().catch(fail);
