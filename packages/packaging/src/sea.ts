import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { createArtifactManifest, packageLayout, RELEASE_TARGETS, seaBuildPlan, writeArtifactManifest, writeSeaConfig, type ArtifactManifest, type PackageLayout, type ReleaseTarget } from "./build.js";
import { assertHostAbiMatchesAddons, discoverNativeAddonAssets, type NativeAddonAsset } from "./native.js";

const require = createRequire(import.meta.url);

export interface BundleOptions { projectRoot: string; outputDirectory: string }
export interface BundleResult {
  launcherPath: string;
  assetDirectory: string;
  nativeAssets: readonly NativeAddonAsset[];
  embeddedAssetSha256: string;
}
export interface SeaCommandOptions extends BundleOptions { target: ReleaseTarget; releaseVersion: string }

export function hostTarget(): ReleaseTarget {
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "macos-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  throw new Error(`Unsupported packaging host: ${process.platform}-${process.arch}`);
}

export async function buildPlan(target: ReleaseTarget, releaseVersion: string, projectRoot: string): Promise<PackageLayout> {
  if (!RELEASE_TARGETS.includes(target)) throw new Error(`Unsupported release target: ${target}`);
  return packageLayout(path.resolve(projectRoot, "dist", "packages"), target, releaseVersion);
}

export async function hashEmbeddedAssets(assets: Record<string, string>): Promise<string> {
  const entries: [string, string][] = [];
  for (const key of Object.keys(assets).sort()) {
    entries.push([key, createHash("sha256").update(await fs.readFile(assets[key]!)).digest("hex")]);
  }
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function serverBundle(options: BundleOptions): Promise<{ bundle: BundleResult; assets: Record<string, string> }> {
  const projectRoot = path.resolve(options.projectRoot);
  const directory = path.resolve(options.outputDirectory);
  const launcherPath = path.join(directory, "launcher.mjs");
  const assetDirectory = path.join(directory, "web");
  await fs.access(path.join(assetDirectory, "index.html"));
  const nativeAssets = await discoverNativeAddonAssets(projectRoot);
  await build({
    absWorkingDir: projectRoot,
    entryPoints: ["apps/server/src/sea-entry.ts"], outfile: launcherPath,
    bundle: true, platform: "node", target: "node22", format: "cjs", sourcemap: false,
    // Runtime consumers use only userPaths. Do not pull build-tool side effects
    // from the packaging barrel into the shipped launcher.
    alias: { "@theaihatch/packaging": path.join(projectRoot, "packages/packaging/src/paths.ts") },
    plugins: [{ name: "embedded-native-packages", setup(builder) {
      builder.onResolve({ filter: /^(better-sqlite3|keytar)$/ }, (args) => ({ path: args.path, namespace: "embedded-native" }));
      builder.onLoad({ filter: /.*/, namespace: "embedded-native" }, (args) => ({
        contents: `import { loadNativePackage } from './packages/packaging/src/runtime.ts'; module.exports = loadNativePackage(${JSON.stringify(args.path)});`,
        resolveDir: projectRoot, loader: "js",
      }));
    } }],
  });
  const layout = { ...packageLayout(directory, hostTarget(), "bundle"), launcherPath, webDirectory: assetDirectory };
  const planned = seaBuildPlan(hostTarget(), layout, nativeAssets);
  const webIndex = path.join(directory, "web-index.json");
  await fs.writeFile(webIndex, JSON.stringify(Object.keys(planned.assets).filter((key) => key.startsWith("web/")).sort()));
  const assets = Object.fromEntries(Object.entries({ ...planned.assets, ...await discoverRuntimeAssets(projectRoot, directory), "web-index": webIndex }).sort(([a], [b]) => a < b ? -1 : 1));
  return { bundle: { launcherPath, assetDirectory, nativeAssets, embeddedAssetSha256: await hashEmbeddedAssets(assets) }, assets };
}

export async function bundleServer(options: BundleOptions): Promise<BundleResult> {
  return (await serverBundle(options)).bundle;
}

export async function buildPackage(options: SeaCommandOptions): Promise<ArtifactManifest> {
  if (options.target !== hostTarget()) throw new Error(`Release target ${options.target} does not match packaging host ${hostTarget()}`);
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 22) throw new Error("Packaging requires Node 22 or newer");
  const projectRoot = path.resolve(options.projectRoot);
  const layout = packageLayout(path.resolve(options.outputDirectory), options.target, options.releaseVersion);
  // A release directory is published once. Never overwrite an earlier artifact
  // or leave its manifest describing a later failed build.
  await fs.mkdir(path.dirname(layout.stagingDirectory), { recursive: true });
  let staging: string | undefined;
  let releaseDirectoryCreated = false;
  try {
    await fs.mkdir(layout.stagingDirectory);
    releaseDirectoryCreated = true;
    staging = await fs.mkdtemp(path.join(path.dirname(layout.stagingDirectory), ".sea-build-"));
    const viteCli = path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js");
    execFileSync(process.execPath, [viteCli, "build", "--config", path.join(projectRoot, "vite.config.ts"), "--outDir", path.join(staging, "web")], { cwd: projectRoot, encoding: "utf8", timeout: 120_000 });
    const { bundle, assets } = await serverBundle({ projectRoot, outputDirectory: staging });
    const executable = path.join(staging, path.basename(layout.executablePath));
    await prepareSea(bundle.launcherPath, assets, executable);
    const isolated = await fs.mkdtemp(path.join(staging, "verify-"));
    const relocated = path.join(isolated, path.basename(executable));
    await fs.copyFile(executable, relocated);
    const result = execFileSync(relocated, ["--theaihatch-verify"], {
      cwd: isolated, env: { ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "", THEAIHATCH_RUNTIME_CACHE: path.join(isolated, "cache") },
      encoding: "utf8", timeout: 60_000,
    });
    const verification = JSON.parse(result) as { verified?: boolean; sqlite?: number; keytar?: boolean; web?: boolean };
    if (!verification.verified || verification.sqlite !== 42 || !verification.keytar || !verification.web) throw new Error(`Artifact verification failed: ${result}`);
    if (await hashEmbeddedAssets(assets) !== bundle.embeddedAssetSha256) throw new Error("Embedded inputs changed during SEA preparation");
    await fs.copyFile(executable, layout.executablePath);
    const manifest = await createArtifactManifest(options.target, options.releaseVersion, layout.executablePath, bundle.embeddedAssetSha256);
    await writeArtifactManifest(layout.manifestPath, manifest);
    return manifest;
  } catch (error) {
    // This directory was exclusively created by this invocation.
    if (releaseDirectoryCreated) await fs.rm(layout.stagingDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    if (staging !== undefined) await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function discoverRuntimeAssets(projectRoot: string, outputDirectory: string): Promise<Record<string, string>> {
  const native = await discoverNativeAddonAssets(projectRoot);
  const assets: Record<string, string> = {};
  const files: Record<string, { key: string; sha256: string }> = {};
  const add = async (name: string, root: string, relative: string, key = `runtime/${name}/${relative}`): Promise<void> => {
    const filename = path.join(root, relative);
    try {
      const bytes = await fs.readFile(filename);
      assets[key] = filename;
      files[`node_modules/${name}/${relative}`] = { key, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) { throw new Error(`Native package ${name}: missing runtime asset ${relative}`, { cause: error }); }
  };
  const addTree = async (name: string, root: string, relative: string): Promise<void> => {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await addTree(name, root, file);
      else if (entry.isFile()) await add(name, root, file);
      else throw new Error(`Native package ${name}: nonregular runtime asset ${file}`);
    }
  };
  for (const asset of native) {
    await add(asset.packageName, asset.packageRoot, "package.json");
    await addTree(asset.packageName, asset.packageRoot, "lib");
    await add(asset.packageName, asset.packageRoot, path.relative(asset.packageRoot, asset.binaryPath).split(path.sep).join("/"), asset.assetKey);
  }
  // Runtime-only dependency closure of the wrappers. Install/build tools are not runtime inputs.
  const sqliteRoot = native.find((asset) => asset.packageName === "better-sqlite3")!.packageRoot;
  const bindingsRoot = path.dirname(require.resolve("bindings/package.json", { paths: [sqliteRoot] }));
  const uriRoot = path.dirname(require.resolve("file-uri-to-path/package.json", { paths: [bindingsRoot] }));
  for (const [name, root, entry] of [["bindings", bindingsRoot, "bindings.js"], ["file-uri-to-path", uriRoot, "index.js"]] as const) {
    await add(name, root, "package.json");
    await add(name, root, entry);
  }
  await fs.mkdir(outputDirectory, { recursive: true });
  const mapPath = path.join(outputDirectory, "runtime-map.json");
  await fs.writeFile(mapPath, JSON.stringify({ files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1)) }));
  assets["runtime-map"] = mapPath;
  return Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a < b ? -1 : 1));
}

export async function prepareSea(launcher: string, assets: Record<string, string>, executable: string): Promise<void> {
  assertHostAbiMatchesAddons(Object.values(assets).filter((asset) => asset.endsWith(".node")));
  const configPath = path.join(path.dirname(executable), "sea-config.json");
  await writeSeaConfig(configPath, launcher, assets);
  execFileSync(process.execPath, ["--experimental-sea-config", configPath], { encoding: "utf8", timeout: 60_000 });
  await fs.copyFile(process.execPath, executable);
  if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", executable]);
  const args = [require.resolve("postject/dist/cli.js"), executable, "NODE_SEA_BLOB", `${configPath}.blob`,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  execFileSync(process.execPath, args, { encoding: "utf8", timeout: 60_000 });
  if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", executable]);
}
