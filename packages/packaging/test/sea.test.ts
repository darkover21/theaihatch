import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { build } from "esbuild";
import { discoverRuntimeAssets, prepareSea } from "../src/sea.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

it("loads both native packages from a single SEA with repository resolution forbidden", async () => {
  const directory = await fs.mkdtemp(path.join(projectRoot, "node_modules/.sea-gate-"));
  directories.push(directory);
  const buildDirectory = path.join(directory, "build");
  await fs.mkdir(buildDirectory);
  const launcher = path.join(buildDirectory, "fixture.cjs");
  await build({ entryPoints: [path.join(import.meta.dirname, "fixtures/sea-native.ts")], outfile: launcher,
    bundle: true, platform: "node", target: "node22", format: "cjs" });
  const assets = await discoverRuntimeAssets(projectRoot, buildDirectory);
  const executable = path.join(buildDirectory, process.platform === "win32" ? "fixture.exe" : "fixture");
  await prepareSea(launcher, assets, executable);
  const isolated = path.join(directory, "isolated");
  await fs.mkdir(isolated);
  const relocated = path.join(isolated, path.basename(executable));
  await fs.copyFile(executable, relocated);
  // Remove ALL build resources before launching the only distributed payload.
  await fs.rm(path.join(directory, "build"), { recursive: true });
  const result = spawnSync(relocated, [], {
    cwd: isolated,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", PATH: "", THEAIHATCH_RUNTIME_CACHE: path.join(isolated, "cache") },
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status, `${result.error ?? ""}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ answer: 42, keytar: true });
}, 120_000);
