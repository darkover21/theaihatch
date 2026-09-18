import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverNativeAddonAssets } from "../src/native.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("native addon inventory", () => {
  it("REQ-PKG-001: discovers both runtime native package binaries in this checkout", async () => {
    const assets = await discoverNativeAddonAssets(process.cwd());

    expect(assets.map((asset) => asset.packageName)).toEqual(["better-sqlite3", "keytar"]);
    for (const asset of assets) {
      expect(asset.packageRoot).toContain(path.join("node_modules", asset.packageName));
      expect(asset.binaryPath).toMatch(/\.node$/u);
      expect(asset.assetKey).toMatch(new RegExp(`^native/${asset.packageName}/`, "u"));
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect((await fs.stat(asset.binaryPath)).isFile()).toBe(true);
    }
  });

  it("REQ-PKG-001: reports the native package and expected binary path when an input is missing", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-missing-native-"));
    temporaryDirectories.push(projectRoot);
    const packageRoot = path.join(projectRoot, "node_modules", "better-sqlite3");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"better-sqlite3"}\n', "utf8");

    await expect(discoverNativeAddonAssets(projectRoot)).rejects.toThrow("better-sqlite3");
    await expect(discoverNativeAddonAssets(projectRoot)).rejects.toThrow(path.join(packageRoot, "build", "Release", "better_sqlite3.node"));
  });
});
