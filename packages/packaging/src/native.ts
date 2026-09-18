import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
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
  try {
    const stats = await fs.stat(expectedPath);
    if (stats.isFile()) return expectedPath;
  } catch {
    // The diagnostic below names the exact runtime binary path required by the launcher.
  }

  throw new Error(`Native addon ${packageName} is missing its binary; expected ${expectedPath}`);
}

function isWindowsX64Binary(bytes: Buffer): boolean {
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") return false;
  const peOffset = bytes.readUInt32LE(0x3c);
  return bytes.length >= peOffset + 6
    && bytes.toString("ascii", peOffset, peOffset + 4) === "PE\u0000\u0000"
    && bytes.readUInt16LE(peOffset + 4) === 0x8664;
}

function isLinuxX64Binary(bytes: Buffer): boolean {
  return bytes.length >= 20
    && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    && bytes[4] === 2
    && bytes[5] === 1
    && bytes.readUInt16LE(18) === 0x3e;
}

function isMacOsArm64Binary(bytes: Buffer): boolean {
  const arm64CpuType = 0x0100000c;
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) return bytes.readUInt32LE(4) === arm64CpuType;

  const magic = bytes.length >= 8 ? bytes.readUInt32BE(0) : 0;
  const entrySize = magic === 0xcafebabe ? 20 : magic === 0xcafebabf ? 32 : 0;
  if (entrySize === 0) return false;
  const architectureCount = bytes.readUInt32BE(4);
  for (let index = 0; index < architectureCount; index += 1) {
    const offset = 8 + (index * entrySize);
    if (bytes.length < offset + 4) return false;
    if (bytes.readUInt32BE(offset) === arm64CpuType) return true;
  }
  return false;
}

function assertCurrentPlatformBinary(packageName: NativeAddonName, binaryPath: string, bytes: Buffer): void {
  const compatible = (process.platform === "win32" && process.arch === "x64" && isWindowsX64Binary(bytes))
    || (process.platform === "linux" && process.arch === "x64" && isLinuxX64Binary(bytes))
    || (process.platform === "darwin" && process.arch === "arm64" && isMacOsArm64Binary(bytes));
  if (!compatible) {
    throw new Error(
      `Native addon ${packageName} at ${binaryPath} is incompatible with current OS/architecture (${process.platform}-${process.arch})`,
    );
  }
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
    assertCurrentPlatformBinary(packageName, binaryPath, bytes);
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
