import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildPackage, buildPlan, bundleServer, hashEmbeddedAssets, hostTarget } from "../src/sea.js";
import { writeSeaConfig } from "../src/build.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
async function temp() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hatch-bundle-"));
  directories.push(directory);
  return directory;
}

it("plans every supported target deterministically without creating output", async () => {
  const root = await temp();
  const plan = await buildPlan("linux-x64", "1.2.3", root);
  expect(plan.executablePath).toBe(path.join(root, "dist", "packages", "linux-x64", "1.2.3", "theaihatch-1.2.3-linux-x64"));
  expect(await buildPlan("linux-x64", "1.2.3", root)).toEqual(plan);
  expect(await fs.readdir(root)).toEqual([]);
  await expect(buildPlan("linux-arm64" as never, "1.2.3", root)).rejects.toThrow(/Unsupported/);
});

it("rejects a host-target mismatch before creating any artifacts", async () => {
  const root = await temp();
  const target = hostTarget() === "linux-x64" ? "windows-x64" : "linux-x64";
  await expect(buildPackage({ projectRoot, target, releaseVersion: "1.2.3", outputDirectory: root })).rejects.toThrow(/host/);
  expect(await fs.readdir(root)).toEqual([]);
});

it("hashes sorted asset keys and bytes, independently of insertion order and filenames", async () => {
  const root = await temp();
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  await fs.writeFile(a, "alpha");
  await fs.writeFile(b, "beta");
  const first = await hashEmbeddedAssets({ z: b, a });
  expect(await hashEmbeddedAssets({ a, z: b })).toBe(first);
  await fs.writeFile(b, "changed");
  expect(await hashEmbeddedAssets({ a, z: b })).not.toBe(first);
  expect(await hashEmbeddedAssets({ a, y: b })).not.toBe(await hashEmbeddedAssets({ a, z: b }));
  const config = path.join(root, "sea.json");
  await writeSeaConfig(config, a, { z: b, a });
  expect(Object.keys(JSON.parse(await fs.readFile(config, "utf8")).assets)).toEqual(["a", "z"]);
});

it("bundles a deterministic server launcher with complete embedded runtime inputs", async () => {
  const first = await temp();
  const second = await temp();
  for (const directory of [first, second]) {
    await fs.mkdir(path.join(directory, "web"));
    await fs.writeFile(path.join(directory, "web", "index.html"), "<h1>packaged</h1>");
  }
  const a = await bundleServer({ projectRoot, outputDirectory: first });
  const b = await bundleServer({ projectRoot, outputDirectory: second });
  expect(await fs.readFile(a.launcherPath)).toEqual(await fs.readFile(b.launcherPath));
  expect(a.embeddedAssetSha256).toBe(b.embeddedAssetSha256);
  expect(a.nativeAssets.map((asset) => asset.packageName)).toEqual(["better-sqlite3", "keytar"]);
  expect(a.embeddedAssetSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(createHash("sha256").update(await fs.readFile(a.launcherPath)).digest("hex")).not.toBe(a.embeddedAssetSha256);
}, 60_000);

it("publishes a verified server executable with a final-byte manifest and no adjacent inputs", async () => {
  const output = await temp();
  const isolated = await temp();
  const target = hostTarget();
  const manifest = await buildPackage({ projectRoot, outputDirectory: output, target, releaseVersion: "1.2.3" });
  await expect(buildPackage({ projectRoot, outputDirectory: output, target, releaseVersion: "1.2.3" })).rejects.toThrow(/EEXIST/);
  const release = path.join(output, target, "1.2.3");
  const executable = path.join(release, manifest.executable);
  const bytes = await fs.readFile(executable);
  expect(manifest.executableSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(JSON.parse(await fs.readFile(path.join(release, "manifest.json"), "utf8"))).toEqual(manifest);
  expect(await fs.readFile(`${executable}.sha256`, "utf8")).toBe(`${manifest.executableSha256}  ${manifest.executable}\n`);
  expect((await fs.readdir(release)).sort()).toEqual(["manifest.json", manifest.executable, `${manifest.executable}.sha256`].sort());
  const relocated = path.join(isolated, manifest.executable);
  await fs.copyFile(executable, relocated);
  await fs.rm(output, { recursive: true });
  const result = spawnSync(relocated, ["--theaihatch-verify"], {
    cwd: isolated, env: { ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "", THEAIHATCH_RUNTIME_CACHE: path.join(isolated, "cache") },
    encoding: "utf8", timeout: 60_000,
  });
  expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ verified: true, sqlite: 42, keytar: true, web: true });
  const concurrent = await Promise.allSettled([0, 1].map(() => promisify(execFile)(relocated, ["--theaihatch-verify"], {
    cwd: isolated, env: { ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "", THEAIHATCH_RUNTIME_CACHE: path.join(isolated, "deep-cache-".repeat(10), "concurrent-cache") },
    encoding: "utf8", timeout: 60_000,
  })));
  for (const child of concurrent) {
    if (child.status === "rejected") throw child.reason;
    expect(JSON.parse(child.value.stdout)).toEqual({ verified: true, sqlite: 42, keytar: true, web: true });
  }
}, 180_000);

it("leaves no release or manifest when build inputs cannot be resolved", async () => {
  const root = await temp();
  const output = path.join(root, "output");
  await expect(buildPackage({ projectRoot: root, outputDirectory: output, target: hostTarget(), releaseVersion: "1.2.3" })).rejects.toThrow();
  expect(await fs.readdir(path.join(output, hostTarget()))).toEqual([]);
});

it("removes the release directory when staging allocation fails", async () => {
  const root = await temp();
  const output = path.join(root, "output");
  vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(new Error("staging allocation unavailable"));

  await expect(buildPackage({ projectRoot, outputDirectory: output, target: hostTarget(), releaseVersion: "1.2.3" })).rejects.toThrow("staging allocation unavailable");
  expect(await fs.readdir(path.join(output, hostTarget()))).toEqual([]);
  vi.restoreAllMocks();
});

it("CLI plans the requested target and rejects build without an explicit target", () => {
  const cli = path.join(projectRoot, "node_modules/vite-node/vite-node.mjs");
  const script = path.join(projectRoot, "packages/packaging/src/cli.ts");
  const plan = spawnSync(process.execPath, [cli, "--script", script, "plan", "--target", "linux-x64", "--version", "2.3.4"], { cwd: projectRoot, encoding: "utf8" });
  expect(plan.status, plan.stderr).toBe(0);
  expect(JSON.parse(plan.stdout)).toMatchObject({ target: "linux-x64", releaseVersion: "2.3.4" });
  const failed = spawnSync(process.execPath, [cli, "--script", script, "build"], { cwd: projectRoot, encoding: "utf8", env: { ...process.env, THEAIHATCH_TARGET: "" } });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("THEAIHATCH_TARGET");
}, 30_000);
