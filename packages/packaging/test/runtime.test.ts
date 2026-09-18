import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const embedded = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("node:sea", () => ({ getAsset: (key: string) => {
  const bytes = embedded.get(key);
  if (!bytes) throw new Error(`Unknown SEA asset: ${key}`);
  return bytes;
} }));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  embedded.clear();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>) {
  vi.resetModules();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hatch-runtime-"));
  directories.push(directory);
  vi.stubEnv("THEAIHATCH_RUNTIME_CACHE", directory);
  const inventory = Object.fromEntries(Object.entries(files).map(([name, source]) => {
    const bytes = Buffer.from(source);
    embedded.set(name, bytes);
    return [name, { key: name, sha256: createHash("sha256").update(bytes).digest("hex") }];
  }));
  embedded.set("runtime-map", Buffer.from(JSON.stringify({ files: inventory })));
  return import("../src/runtime.js");
}

it("allows a native wrapper to continue after an absent candidate", async () => {
  const { loadNativePackage } = await fixture({
    "node_modules/better-sqlite3/package.json": '{"main":"lib/index.js"}',
    "node_modules/better-sqlite3/lib/index.js": `
      const path = require('node:path');
      try { require(path.join(__dirname, '../build/better_sqlite3.node')); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
      module.exports = require('../build/Release/answer');`,
    "node_modules/better-sqlite3/build/Release/answer.js": "module.exports = 42;",
  });
  expect(loadNativePackage("better-sqlite3")).toBe(42);
});

it("resolves a dependency relative to its owning package within the inventory", async () => {
  const { loadNativePackage } = await fixture({
    "node_modules/better-sqlite3/package.json": '{"main":"lib"}',
    "node_modules/better-sqlite3/lib/index.js": "module.exports = require('helper');",
    "node_modules/better-sqlite3/node_modules/helper/package.json": '{"main":"answer"}',
    "node_modules/better-sqlite3/node_modules/helper/answer.json": "42",
    "node_modules/helper/index.js": "module.exports = -1;",
  });
  expect(loadNativePackage("better-sqlite3")).toBe(42);
});

it("reports the package and missing input on exhaustion without ambient lookup", async () => {
  const { loadNativePackage } = await fixture({
    "node_modules/better-sqlite3/index.js": "module.exports = require('vitest');",
  });
  expect(() => loadNativePackage("better-sqlite3")).toThrow(/Native package better-sqlite3 failed:.*vitest/);
});

it("does not keep partially evaluated modules after a missing dependency", async () => {
  const { loadNativePackage } = await fixture({
    "node_modules/better-sqlite3/index.js": "module.exports = require('./missing');",
  });
  expect(() => loadNativePackage("better-sqlite3")).toThrow(/missing/);
  expect(() => loadNativePackage("better-sqlite3")).toThrow(/missing/);
});

it("rejects a symlinked cache ancestor before extracting runtime files", async () => {
  const { loadNativePackage } = await fixture({
    "node_modules/better-sqlite3/index.js": "module.exports = 42;",
  });
  const root = path.join(directories.at(-1)!, createHash("sha256").update(embedded.get("runtime-map")!).digest("hex"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hatch-outside-"));
  directories.push(outside);
  await fs.mkdir(root);
  await fs.symlink(outside, path.join(root, "node_modules"), "junction");
  expect(() => loadNativePackage("better-sqlite3")).toThrow(/symlink|directory/i);
  expect(await fs.readdir(outside)).toEqual([]);
});

it("rejects relative cache overrides instead of resolving them against cwd", async () => {
  const { loadNativePackage } = await fixture({ "node_modules/better-sqlite3/index.js": "module.exports = 42;" });
  // An existing same-drive temporary directory makes the old implementation's write safe.
  const directory = await fs.mkdtemp(path.resolve("node_modules/.runtime-relative-"));
  directories.push(directory);
  vi.stubEnv("THEAIHATCH_RUNTIME_CACHE", path.relative(process.cwd(), directory));
  expect(() => loadNativePackage("better-sqlite3")).toThrow(/absolute/);
});

it("rejects an existing cache directory beneath a symlinked ancestor", async () => {
  const { loadNativePackage } = await fixture({ "node_modules/better-sqlite3/index.js": "module.exports = 42;" });
  const cacheBase = directories.at(-1)!;
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hatch-existing-cache-"));
  directories.push(outside);
  await fs.mkdir(path.join(outside, "existing"));
  const junction = path.join(cacheBase, "junction");
  await fs.symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
  vi.stubEnv("THEAIHATCH_RUNTIME_CACHE", path.join(junction, "existing"));

  expect(() => loadNativePackage("better-sqlite3")).toThrow(/symlink|directory/i);
  expect(await fs.readdir(path.join(outside, "existing"))).toEqual([]);
});
