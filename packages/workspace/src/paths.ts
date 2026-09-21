import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export interface WorkspaceRoot {
  readonly canonicalPath: string;
  readonly rootName: string;
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function ensureWithin(root: WorkspaceRoot, candidate: string): void {
  if (!isWithin(root.canonicalPath, candidate)) {
    throw new WorkspacePathError("path resolves outside the workspace root");
  }
}

export async function openWorkspaceRoot(candidate: string): Promise<WorkspaceRoot> {
  if (candidate.trim() === "" || candidate.includes("\u0000")) {
    throw new WorkspacePathError("workspace folder must be a non-empty path");
  }
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(candidate);
  } catch {
    throw new WorkspacePathError(`workspace folder is missing or unreadable: ${candidate}`);
  }
  let stats;
  try {
    stats = await fs.stat(canonicalPath);
  } catch {
    throw new WorkspacePathError(`workspace folder is unreadable: ${candidate}`);
  }
  if (!stats.isDirectory()) throw new WorkspacePathError("workspace path is not a folder");
  return { canonicalPath, rootName: path.basename(canonicalPath) || canonicalPath };
}

function existingCanonicalPath(candidate: string): string | null {
  try {
    return realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function canonicalizeDeepest(absolute: string): string {
  let current = absolute;
  const tail: string[] = [];
  while (existingCanonicalPath(current) === null) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    tail.unshift(path.basename(current));
    current = parent;
  }
  return tail.reduce((value, segment) => path.join(value, segment), existingCanonicalPath(current) ?? current);
}

export function normalizeWorkspacePath(root: WorkspaceRoot, candidate: string): string {
  if (candidate.includes("\u0000")) throw new WorkspacePathError("workspace path contains a NUL character");
  const nativeCandidate = candidate.replace(/[\\/]+/gu, path.sep);
  const absolute = path.isAbsolute(nativeCandidate)
    ? path.normalize(nativeCandidate)
    : path.resolve(root.canonicalPath, nativeCandidate || ".");
  const canonicalCandidate = isWithin(root.canonicalPath, absolute) ? (existingCanonicalPath(absolute) ?? absolute) : canonicalizeDeepest(absolute);
  ensureWithin(root, canonicalCandidate);

  const relative = path.relative(root.canonicalPath, canonicalCandidate ?? absolute);
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkspacePathError("path resolves outside the workspace root");
  }
  return relative.split(path.sep).join("/");
}

export function resolveWorkspacePath(root: WorkspaceRoot, candidate: string): string {
  const normalized = normalizeWorkspacePath(root, candidate);
  return absoluteFromNormalized(root, normalized);
}

export function absoluteFromNormalized(root: WorkspaceRoot, normalizedRelative: string): string {
  return normalizedRelative === "." ? root.canonicalPath : path.resolve(root.canonicalPath, normalizedRelative.split("/").join(path.sep));
}

export function workspacePathFromAbsolute(root: WorkspaceRoot, candidate: string): string {
  return normalizeWorkspacePath(root, candidate);
}
