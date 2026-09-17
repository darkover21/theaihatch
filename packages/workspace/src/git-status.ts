import { spawn } from "node:child_process";
import type { WorkspaceRoot } from "./paths.js";

export type GitStatusKind = "staged" | "modified" | "untracked" | "renamed" | "deleted" | "conflicted";

export interface GitStatusEntry {
  path: string;
  kind: GitStatusKind;
  staged: boolean;
  worktree: boolean;
  previousPath?: string;
}

export interface GitStatusSnapshot {
  isRepository: boolean;
  entries: GitStatusEntry[];
  decorations: Map<string, GitStatusKind>;
}

function statusKind(indexStatus: string, worktreeStatus: string): GitStatusKind {
  if (indexStatus === "U" || worktreeStatus === "U" || (indexStatus === "A" && worktreeStatus === "A")) return "conflicted";
  if (indexStatus === "R" || worktreeStatus === "R" || indexStatus === "C" || worktreeStatus === "C") return "renamed";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus !== " " && worktreeStatus === " ") return "staged";
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  return "modified";
}

export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const records = output.split("\u0000");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;
    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const path = record.slice(3).replace(/\\/gu, "/");
    if (indexStatus === "!" && worktreeStatus === "!") continue;
    const renamed = indexStatus === "R" || worktreeStatus === "R" || indexStatus === "C" || worktreeStatus === "C";
    const previousPath = renamed ? records[index + 1]?.replace(/\\/gu, "/") : undefined;
    if (renamed) index += 1;
    entries.push({
      path,
      kind: statusKind(indexStatus, worktreeStatus),
      staged: indexStatus !== " " && indexStatus !== "?",
      worktree: worktreeStatus !== " " && worktreeStatus !== "?",
      ...(previousPath === undefined ? {} : { previousPath })
    });
  }
  return entries;
}

function runGit(root: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve({ code: 127, output: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

function decorationPriority(kind: GitStatusKind): number {
  return { conflicted: 6, renamed: 5, deleted: 4, modified: 3, staged: 2, untracked: 1 }[kind];
}

export function decorateGitStatus(entries: readonly GitStatusEntry[]): Map<string, GitStatusKind> {
  const decorations = new Map<string, GitStatusKind>();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let length = segments.length; length >= 1; length -= 1) {
      const candidate = segments.slice(0, length).join("/");
      const current = decorations.get(candidate);
      if (current === undefined || decorationPriority(entry.kind) > decorationPriority(current)) decorations.set(candidate, entry.kind);
    }
  }
  return decorations;
}

export async function readGitStatus(root: WorkspaceRoot): Promise<GitStatusSnapshot> {
  const result = await runGit(root.canonicalPath);
  if (result.code !== 0) return { isRepository: false, entries: [], decorations: new Map() };
  const entries = parsePorcelainZ(result.output);
  return { isRepository: true, entries, decorations: decorateGitStatus(entries) };
}
