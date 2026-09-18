import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEASE_TARGETS,
  createArtifactManifest,
  packageLayout,
  seaBuildPlan,
  targetExecutableName,
  writeArtifactManifest,
  writeSeaConfig,
} from "../src/build.js";
import type { NativeAddonAsset } from "../src/native.js";
import { userPaths } from "../src/paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("packaging", () => {
  it("REQ-PKG-001: gives every release target a deterministic executable name and layout", () => {
    expect(RELEASE_TARGETS).toEqual(["windows-x64", "macos-arm64", "linux-x64"]);
    expect(RELEASE_TARGETS.map((target) => targetExecutableName(target, "0.1.0"))).toEqual([
      "theaihatch-0.1.0-windows-x64.exe",
      "theaihatch-0.1.0-macos-arm64",
      "theaihatch-0.1.0-linux-x64",
    ]);

    for (const target of RELEASE_TARGETS) {
      const layout = packageLayout("/tmp/out", target, "0.1.0");
      expect(layout).toEqual({
        target,
        releaseVersion: "0.1.0",
        stagingDirectory: path.join("/tmp/out", target, "0.1.0"),
        webDirectory: path.join("/tmp/out", target, "0.1.0", "web"),
        launcherPath: path.join("/tmp/out", target, "0.1.0", "launcher.mjs"),
        executablePath: path.join("/tmp/out", target, "0.1.0", targetExecutableName(target, "0.1.0")),
        manifestPath: path.join("/tmp/out", target, "0.1.0", "manifest.json"),
        checksumPath: path.join("/tmp/out", target, "0.1.0", `${targetExecutableName(target, "0.1.0")}.sha256`),
      });
    }

    expect(() => packageLayout("/tmp/out", "linux-x64", "../outside")).toThrow(/releaseVersion/u);
    expect(() => packageLayout("/tmp/out", "linux-x64", "0.1.0/escaped")).toThrow(/releaseVersion/u);
  });

  it("REQ-PKG-001: plans every release target with individual web launcher and native assets", async () => {
    const nativeAsset: NativeAddonAsset = {
      packageName: "better-sqlite3",
      packageRoot: "/runtime/better-sqlite3",
      binaryPath: "/runtime/better-sqlite3/build/Release/better_sqlite3.node",
      assetKey: "native/better-sqlite3/build/Release/better_sqlite3.node",
      sha256: "native-digest",
    };

    for (const target of RELEASE_TARGETS) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-sea-plan-"));
      temporaryDirectories.push(directory);
      const layout = packageLayout(directory, target, "0.1.0");
      const indexPath = path.join(layout.webDirectory, "index.html");
      const scriptPath = path.join(layout.webDirectory, "assets", "app.js");
      await fs.mkdir(path.dirname(scriptPath), { recursive: true });
      await fs.writeFile(indexPath, "<main>theaihatch</main>", "utf8");
      await fs.writeFile(scriptPath, "console.log('theaihatch');", "utf8");
      await fs.writeFile(layout.launcherPath, "export {};", "utf8");
      const plan = seaBuildPlan(target, layout, [nativeAsset]);
      expect(plan).toMatchObject({
        target,
        mode: "node-sea",
        executableName: targetExecutableName(target, "0.1.0"),
        nativeAssets: [nativeAsset],
      });
      expect(plan.assets).toEqual({
        launcher: layout.launcherPath,
        "web/assets/app.js": scriptPath,
        "web/index.html": indexPath,
        [nativeAsset.assetKey]: nativeAsset.binaryPath,
      });
      expect(Object.values(plan.assets)).not.toContain(layout.webDirectory);

      const configPath = path.join(directory, "sea-config.json");
      await writeSeaConfig(configPath, layout.launcherPath, plan.assets);
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as { assets: Record<string, string> };
      expect(config.assets["web/index.html"]).toBe(path.resolve(indexPath));
      expect(config.assets["web/index.html"]).not.toBe(path.resolve(layout.webDirectory));
    }
  });

  it("REQ-PKG-001: hashes the final executable and writes stable manifest companions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-packaging-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "theaihatch-0.1.0-linux-x64");
    await fs.writeFile(executable, "final executable bytes", "utf8");
    const digest = createHash("sha256").update("final executable bytes").digest("hex");

    const manifest = await createArtifactManifest("linux-x64", "0.1.0", executable, "embedded-digest");
    expect(manifest).toEqual({
      schemaVersion: 1,
      target: "linux-x64",
      releaseVersion: "0.1.0",
      executable: "theaihatch-0.1.0-linux-x64",
      executableSha256: digest,
      embeddedAssetSha256: "embedded-digest",
    });

    const manifestPath = path.join(directory, "manifest.json");
    await writeArtifactManifest(manifestPath, manifest);
    await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    await expect(fs.readFile(path.join(directory, "theaihatch-0.1.0-linux-x64.sha256"), "utf8")).resolves.toBe(`${digest}  theaihatch-0.1.0-linux-x64\n`);

    const reorderedManifest = {
      embeddedAssetSha256: "embedded-digest",
      executableSha256: digest,
      executable: "theaihatch-0.1.0-linux-x64",
      releaseVersion: "0.1.0",
      target: "linux-x64" as const,
      schemaVersion: 1 as const,
    };
    await writeArtifactManifest(manifestPath, reorderedManifest);
    await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });

  it("REQ-PKG-005: resolves platform data locations", () => {
    expect(userPaths("win32", "C:\\Users\\demo").data).toContain("AppData");
    expect(userPaths("darwin", "/Users/demo").config).toContain("Library");
    expect(userPaths("linux", "/home/demo").config).toContain(".config");
  });
});
