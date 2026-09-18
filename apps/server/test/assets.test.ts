import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/app.js";
import { createEmbeddedAssetProvider, createFilesystemAssetProvider } from "../src/bootstrap/assets.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-assets-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "index.html"), "<main>root</main>", "utf8");
  await fs.writeFile(path.join(root, "assets", "app.js"), "console.log('app');", "utf8");
  return root;
}

describe("web asset providers", () => {
  it("reads normalized filesystem web paths without allowing traversal", async () => {
    const provider = createFilesystemAssetProvider(await fixture());

    await expect(provider.read("/index.html")).resolves.toMatchObject({ body: Buffer.from("<main>root</main>"), contentType: "text/html; charset=utf-8" });
    await expect(provider.read("/assets/app.js")).resolves.toMatchObject({ body: Buffer.from("console.log('app');"), contentType: "text/javascript; charset=utf-8" });
    await expect(provider.read("../secret")).resolves.toBeNull();
    await expect(provider.read("\0")).resolves.toBeNull();
  });

  it("maps logical web paths to embedded SEA asset keys", async () => {
    const assets = new Map<string, Buffer>([["web/index.html", Buffer.from("<main>embedded</main>")]]);
    const provider = createEmbeddedAssetProvider(async (key) => assets.get(key) ?? null);

    await expect(provider.read("/index.html")).resolves.toMatchObject({ body: Buffer.from("<main>embedded</main>"), contentType: "text/html; charset=utf-8" });
    await expect(provider.read("/missing.js")).resolves.toBeNull();
  });
});

describe("packaged web routes", () => {
  it("REQ-PKG-001: serves embedded assets and keeps API paths separate", async () => {
    const assets = new Map<string, Buffer>([["web/index.html", Buffer.from("<main>root</main>")]]);
    const app = createServer(undefined, undefined, createEmbeddedAssetProvider(async (key) => assets.get(key) ?? null));

    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/workspace/demo" })).body).toContain("root");
    expect((await app.inject({ method: "GET", url: "/api/missing" })).statusCode).toBe(404);
    await app.close();
  });
});
