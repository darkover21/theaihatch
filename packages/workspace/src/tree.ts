import { promises as fs } from "node:fs";
import path from "node:path";
import { IgnoreMatcher } from "./ignore.js";
import { absoluteFromNormalized, normalizeWorkspacePath, openWorkspaceRoot, resolveWorkspacePath, type WorkspaceRoot } from "./paths.js";

export type WorkspaceEntryKind = "file" | "directory";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
}

function entryOrder(left: WorkspaceEntry, right: WorkspaceEntry): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  const insensitive = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  return insensitive === 0 ? left.name.localeCompare(right.name) : insensitive;
}

export class WorkspaceTree {
  readonly root: WorkspaceRoot;
  private matcher: IgnoreMatcher;

  private constructor(root: WorkspaceRoot, matcher: IgnoreMatcher) {
    this.root = root;
    this.matcher = matcher;
  }

  static async open(candidate: string): Promise<WorkspaceTree> {
    const root = await openWorkspaceRoot(candidate);
    return new WorkspaceTree(root, await IgnoreMatcher.fromWorkspace(root.canonicalPath));
  }

  async reloadIgnoreRules(): Promise<void> {
    this.matcher = await IgnoreMatcher.fromWorkspace(this.root.canonicalPath);
  }

  normalize(candidate: string): string {
    return normalizeWorkspacePath(this.root, candidate);
  }

  absolute(candidate: string): string {
    return resolveWorkspacePath(this.root, candidate);
  }

  isIgnored(candidate: string, isDirectory = false): boolean {
    return this.matcher.isIgnored(this.normalize(candidate), isDirectory);
  }

  async list(relativeDirectory = "."): Promise<WorkspaceEntry[]> {
    const directory = this.normalize(relativeDirectory);
    if (this.matcher.isIgnored(directory, true)) return [];
    const absoluteDirectory = this.absolute(directory);
    const directoryEntries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    const entries: WorkspaceEntry[] = [];
    for (const entry of directoryEntries) {
      const candidate = directory === "." ? entry.name : path.posix.join(directory, entry.name);
      const isDirectory = entry.isDirectory();
      if (this.matcher.isIgnored(candidate, isDirectory)) continue;
      if (entry.isSymbolicLink()) {
        const absoluteCandidate = absoluteFromNormalized(this.root, candidate);
        try {
          const target = await fs.realpath(absoluteCandidate);
          const targetRelative = normalizeWorkspacePath(this.root, target);
          const targetStats = await fs.stat(target);
          if (this.matcher.isIgnored(targetRelative, targetStats.isDirectory())) continue;
          entries.push({ name: entry.name, path: candidate, kind: targetStats.isDirectory() ? "directory" : "file" });
        } catch {
          continue;
        }
      } else {
        entries.push({ name: entry.name, path: candidate, kind: isDirectory ? "directory" : "file" });
      }
    }
    return entries.sort(entryOrder);
  }

  async stat(candidate: string): Promise<{ kind: WorkspaceEntryKind; size: number }> {
    const normalized = this.normalize(candidate);
    if (this.matcher.isIgnored(normalized, false)) throw new Error("path is ignored");
    const stats = await fs.stat(this.absolute(normalized));
    return { kind: stats.isDirectory() ? "directory" : "file", size: stats.size };
  }

  async readFile(candidate: string): Promise<string> {
    const normalized = this.normalize(candidate);
    if (normalized === "." || this.matcher.isIgnored(normalized, false)) throw new Error("file is not readable");
    return fs.readFile(this.absolute(normalized), "utf8");
  }

  async writeFile(candidate: string, content: string): Promise<void> {
    const normalized = this.normalize(candidate);
    if (normalized === "." || this.matcher.isIgnored(normalized, false)) throw new Error("file is not writable");
    const target = this.absolute(normalized);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }

  async createFile(candidate: string, content = ""): Promise<void> {
    const normalized = this.normalize(candidate);
    if (normalized === "." || this.matcher.isIgnored(normalized, false)) throw new Error("file is not writable");
    const target = this.absolute(normalized);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" });
  }

  async deleteFile(candidate: string): Promise<void> {
    const normalized = this.normalize(candidate);
    if (normalized === "." || this.matcher.isIgnored(normalized, false)) throw new Error("workspace path cannot be deleted");
    await fs.unlink(this.absolute(normalized));
  }
}

export async function listWorkspaceDirectory(candidate: string, relativeDirectory = "."): Promise<WorkspaceEntry[]> {
  const tree = await WorkspaceTree.open(candidate);
  return tree.list(relativeDirectory);
}
