import { createHash } from "node:crypto";
import { promises as fs, readdirSync } from "node:fs";
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
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(releaseVersion)) {
    throw new Error(`releaseVersion must be a non-empty safe path segment: ${releaseVersion}`);
  }

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

function webAssets(webDirectory: string): Record<string, string> {
  const assets: Record<string, string> = {};
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Web asset is not a regular file: ${candidate}`);

      const relativePath = path.relative(webDirectory, candidate).split(path.sep).join("/");
      assets[`web/${relativePath}`] = candidate;
    }
  };

  visit(webDirectory);
  if (Object.keys(assets).length === 0) throw new Error(`Web asset directory contains no files: ${webDirectory}`);
  return assets;
}

export function seaBuildPlan(target: ReleaseTarget, layout: PackageLayout, nativeAssets: readonly NativeAddonAsset[]): SeaBuildPlan {
  return {
    target,
    mode: "node-sea",
    executableName: path.basename(layout.executablePath),
    assets: {
      launcher: layout.launcherPath,
      ...webAssets(layout.webDirectory),
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
  const stableManifest: ArtifactManifest = {
    schemaVersion: manifest.schemaVersion,
    target: manifest.target,
    releaseVersion: manifest.releaseVersion,
    executable: manifest.executable,
    executableSha256: manifest.executableSha256,
    embeddedAssetSha256: manifest.embeddedAssetSha256,
  };
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(stableManifest, null, 2)}\n`, "utf8");
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
