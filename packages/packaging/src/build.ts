import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { NativeAddonAsset } from "./native.js";

export type ReleaseTarget = "windows-x64" | "macos-arm64" | "linux-x64";

export const RELEASE_TARGETS = ["windows-x64", "macos-arm64", "linux-x64"] as const satisfies readonly ReleaseTarget[];

export interface PackageLayout {
  target: ReleaseTarget;
  releaseVersion: string;
  stagingDirectory: string;
  webDirectory: string;
  launcherPath: string;
  executablePath: string;
  manifestPath: string;
  checksumPath: string;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  target: ReleaseTarget;
  releaseVersion: string;
  executable: string;
  executableSha256: string;
  embeddedAssetSha256: string;
}

export interface SeaBuildPlan {
  target: ReleaseTarget;
  mode: "node-sea";
  executableName: string;
  assets: Record<string, string>;
  nativeAssets: readonly NativeAddonAsset[];
}

export function targetExecutableName(target: ReleaseTarget, releaseVersion: string): string {
  const extension = target === "windows-x64" ? ".exe" : "";
  return `theaihatch-${releaseVersion}-${target}${extension}`;
}

export function packageLayout(root: string, target: ReleaseTarget, releaseVersion: string): PackageLayout {
  const stagingDirectory = path.join(root, target, releaseVersion);
  const executableName = targetExecutableName(target, releaseVersion);

  return {
    target,
    releaseVersion,
    stagingDirectory,
    webDirectory: path.join(stagingDirectory, "web"),
    launcherPath: path.join(stagingDirectory, "launcher.mjs"),
    executablePath: path.join(stagingDirectory, executableName),
    manifestPath: path.join(stagingDirectory, "manifest.json"),
    checksumPath: path.join(stagingDirectory, `${executableName}.sha256`),
  };
}

export function seaBuildPlan(target: ReleaseTarget, layout: PackageLayout, nativeAssets: readonly NativeAddonAsset[]): SeaBuildPlan {
  return {
    target,
    mode: "node-sea",
    executableName: path.basename(layout.executablePath),
    assets: {
      web: layout.webDirectory,
      launcher: layout.launcherPath,
      ...Object.fromEntries(nativeAssets.map((asset) => [asset.assetKey, asset.binaryPath])),
    },
    nativeAssets,
  };
}

export async function createArtifactManifest(
  target: ReleaseTarget,
  releaseVersion: string,
  executable: string,
  embeddedAssetSha256: string,
): Promise<ArtifactManifest> {
  const bytes = await fs.readFile(executable);
  return {
    schemaVersion: 1,
    target,
    releaseVersion,
    executable: path.basename(executable),
    executableSha256: createHash("sha256").update(bytes).digest("hex"),
    embeddedAssetSha256,
  };
}

export async function writeArtifactManifest(manifestPath: string, manifest: ArtifactManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(path.dirname(manifestPath), `${manifest.executable}.sha256`),
    `${manifest.executableSha256}  ${manifest.executable}\n`,
    "utf8",
  );
}

export async function writeSeaConfig(output: string, entrypoint: string, assets: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    JSON.stringify({
      main: path.resolve(entrypoint),
      output: path.resolve(`${output}.blob`),
      disableExperimentalSEAWarning: true,
      assets: Object.fromEntries(Object.entries(assets).map(([key, value]) => [key, path.resolve(value)])),
    }, null, 2),
    "utf8",
  );
}
