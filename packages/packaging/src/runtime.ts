import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { getAsset } from "node:sea";
import { runInThisContext } from "node:vm";
import { userPaths } from "./paths.js";
import type Database from "better-sqlite3";
import type * as Keytar from "keytar";

interface RuntimeFile { key: string; sha256: string }
interface RuntimeMap { files: Record<string, RuntimeFile> }
interface RuntimeModule { exports: unknown }
let runtime: { root: string; files: RuntimeMap["files"]; modules: Map<string, RuntimeModule> } | undefined;

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function ensureDirectory(directory: string): void {
  if (!existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent !== directory) ensureDirectory(parent);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe runtime cache directory (symlink or non-directory): ${directory}`);
}

function extractedRuntime(): NonNullable<typeof runtime> {
  if (runtime !== undefined) return runtime;
  const bytes = Buffer.from(getAsset("runtime-map"));
  const map = JSON.parse(bytes.toString("utf8")) as RuntimeMap;
  const cacheDirectory = process.env.THEAIHATCH_RUNTIME_CACHE ?? path.join(userPaths().data, "runtime");
  if (!path.isAbsolute(cacheDirectory)) throw new Error("THEAIHATCH_RUNTIME_CACHE must be an absolute path");
  const root = path.join(cacheDirectory, sha256(bytes));
  ensureDirectory(path.dirname(root));
  ensureDirectory(root);
  for (const [relative, asset] of Object.entries(map.files)) {
    if (relative.includes("\\") || relative.includes(":") || relative.includes("\0") || relative.split("/").some((part) => part === ".." || part === "." || part === "") || path.isAbsolute(relative)) throw new Error(`Invalid runtime asset: ${relative}`);
    const filename = path.join(root, relative);
    let directory = root;
    for (const segment of relative.split("/").slice(0, -1)) {
      directory = path.join(directory, segment);
      ensureDirectory(directory);
    }
    const embedded = Buffer.from(getAsset(asset.key));
    if (sha256(embedded) !== asset.sha256) throw new Error(`Corrupt embedded runtime asset: ${asset.key}`);
    if (!existsSync(filename)) {
      // Publish only complete bytes. A competing launcher can win publication;
      // neither process ever observes the other's partially written file.
      const temporary = `${filename}.${randomUUID()}.tmp`;
      writeFileSync(temporary, embedded, { flag: "wx", mode: 0o600 });
      try {
        try { linkSync(temporary, filename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      } finally { unlinkSync(temporary); }
    }
    if (!lstatSync(filename).isFile() || sha256(readFileSync(filename)) !== asset.sha256) {
      throw new Error(`Corrupt runtime cache asset: ${asset.key} (${filename})`);
    }
  }
  runtime = { root, files: map.files, modules: new Map() };
  return runtime;
}

// Resolve exclusively against the embedded inventory. Node's ambient package
// lookup (including NODE_PATH and ancestor node_modules) is never used.
function resolveRuntime(request: string, parent: string): string {
  const cache = extractedRuntime();
  const has = (file: string): boolean => Object.hasOwn(cache.files, file);
  const asFile = (relative: string): string | undefined =>
    [relative, `${relative}.js`, `${relative}.json`, `${relative}.node`].find(has);
  const asDirectory = (relative: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(relative)) return undefined;
    seen.add(relative);
    if (has(`${relative}/package.json`)) {
      const metadata = loadRuntime(path.join(cache.root, relative, "package.json"), parent) as { main?: string };
      if (typeof metadata.main === "string") {
        const main = path.posix.join(relative, metadata.main);
        const found = asFile(main) ?? asDirectory(main, seen);
        if (found !== undefined) return found;
      }
    }
    return asFile(`${relative}/index`);
  };
  const candidates: string[] = [];
  if (request.startsWith(".")) candidates.push(path.posix.join(path.posix.dirname(parent), request));
  else if (path.isAbsolute(request)) candidates.push(path.relative(cache.root, request).split(path.sep).join("/"));
  else {
    let directory = path.posix.dirname(parent);
    while (directory !== ".") {
      if (path.posix.basename(directory) !== "node_modules") candidates.push(`${directory}/node_modules/${request}`);
      directory = path.posix.dirname(directory);
    }
    candidates.push(`node_modules/${request}`);
  }
  for (const relative of candidates) {
    const resolved = asFile(relative) ?? asDirectory(relative);
    if (resolved !== undefined) return resolved;
  }
  throw Object.assign(new Error(`Native runtime ${parent}: missing runtime asset ${request}; tried ${candidates.join(", ")}`), { code: "MODULE_NOT_FOUND" });
}

function loadRuntime(request: string, parent: string): unknown {
  if (isBuiltin(request)) return createRequire(process.execPath)(request);
  const cache = extractedRuntime();
  const resolved = resolveRuntime(request, parent);
  const loaded = cache.modules.get(resolved);
  if (loaded !== undefined) return loaded.exports;
  const module: RuntimeModule = { exports: {} };
  cache.modules.set(resolved, module);
  const filename = path.join(cache.root, resolved);
  try {
    if (resolved.endsWith(".node")) process.dlopen(module, path.toNamespacedPath(filename));
    else if (resolved.endsWith(".json")) module.exports = JSON.parse(readFileSync(filename, "utf8"));
    else {
      const compiled = runInThisContext(`(function(exports, require, module, __filename, __dirname) {\n${readFileSync(filename, "utf8")}\n})`, { filename });
      compiled(module.exports, (child: string) => loadRuntime(child, resolved), module, filename, path.dirname(filename));
    }
  } catch (error) {
    cache.modules.delete(resolved);
    throw error;
  }
  return module.exports;
}

export function loadNativePackage(name: "better-sqlite3"): typeof Database;
export function loadNativePackage(name: "keytar"): typeof Keytar;
export function loadNativePackage(name: "better-sqlite3" | "keytar"): unknown {
  try { return loadRuntime(name, `node_modules/${name}/package.json`); }
  catch (error) { throw new Error(`Native package ${name} failed: ${(error as Error).message}`, { cause: error }); }
}
