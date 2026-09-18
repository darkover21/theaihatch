import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const NATIVE_ADDON_NAMES = ["better-sqlite3", "keytar"] as const;

export type NativeAddonName = (typeof NATIVE_ADDON_NAMES)[number];

export interface NativeAddonAsset {
  packageName: NativeAddonName;
  packageRoot: string;
  binaryPath: string;
  assetKey: string;
  sha256: string;
}

const binaryNames: Record<NativeAddonName, string> = {
  "better-sqlite3": "better_sqlite3.node",
  keytar: "keytar.node",
};

function expectedBinaryPath(packageRoot: string, packageName: NativeAddonName): string {
  return path.join(packageRoot, "build", "Release", binaryNames[packageName]);
}

function resolvePackageRoot(projectRoot: string, packageName: NativeAddonName): string {
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`, { paths: [projectRoot] }));
  } catch (error) {
    const packageRoot = path.join(projectRoot, "node_modules", packageName);
    throw new Error(
      `Native addon ${packageName} is unavailable; expected binary at ${expectedBinaryPath(packageRoot, packageName)}`,
      { cause: error },
    );
  }
}

async function discoverBinary(packageRoot: string, packageName: NativeAddonName): Promise<string> {
  const expectedPath = expectedBinaryPath(packageRoot, packageName);
  const directories = [packageRoot];
  const binaryName = binaryNames[packageName];

  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;

    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === binaryName) return candidate;
      if (entry.isDirectory() && entry.name !== "node_modules") directories.push(candidate);
    }
  }

  throw new Error(`Native addon ${packageName} is missing its binary; expected ${expectedPath}`);
}

function assetKey(packageName: NativeAddonName, packageRoot: string, binaryPath: string): string {
  const relativeBinaryPath = path.relative(packageRoot, binaryPath).split(path.sep).join("/");
  return `native/${packageName}/${relativeBinaryPath}`;
}

export async function discoverNativeAddonAssets(projectRoot: string): Promise<readonly NativeAddonAsset[]> {
  const assets: NativeAddonAsset[] = [];

  for (const packageName of NATIVE_ADDON_NAMES) {
    const packageRoot = resolvePackageRoot(projectRoot, packageName);
    const binaryPath = await discoverBinary(packageRoot, packageName);
    const bytes = await fs.readFile(binaryPath);
    assets.push({
      packageName,
      packageRoot,
      binaryPath,
      assetKey: assetKey(packageName, packageRoot, binaryPath),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  return assets;
}
