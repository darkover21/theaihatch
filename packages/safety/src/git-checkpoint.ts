import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
const gitExecutable = process.env.GIT_EXECUTABLE ?? (process.platform === "win32" ? path.join(process.env.ProgramFiles ?? `${path.parse(process.execPath).root}Program Files`, "Git", "cmd", "git.exe") : "git");
interface SnapshotFile { relativePath: string; content: string; encoding: "utf8" | "base64"; }
export interface GitCheckpoint { id: string; root: string; gitCommit: string; indexPath: string | null; files: SnapshotFile[]; createdAt: string; }
async function git(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> { const result = await exec(gitExecutable, args, { cwd: root, env: { ...process.env, ...env }, maxBuffer: 20 * 1024 * 1024 }); return result.stdout; }
async function trackedPaths(root: string): Promise<string[]> { const output = await git(root, ["ls-files", "-z"]); return output.split("\0").filter(Boolean); }
async function allPaths(root: string): Promise<string[]> { const tracked = await trackedPaths(root); const output = await git(root, ["ls-files", "-co", "--exclude-standard", "-z"]); return [...new Set([...tracked, ...output.split("\0").filter(Boolean)])]; }

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLocaleLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

export class GitCheckpointStore {
  async create(root: string, label = "theaihatch checkpoint"): Promise<GitCheckpoint> {
    const canonicalRoot = await fs.realpath(root);
    const repository = await git(canonicalRoot, ["rev-parse", "--show-toplevel"]);
    if (!samePath(repository.trim(), canonicalRoot)) throw new Error("checkpoint root is not the repository root");
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-checkpoint-"));
    const temporaryIndex = path.join(temp, "index");
    const currentIndex = path.join(canonicalRoot, ".git", "index");
    const indexPath = await fs.copyFile(currentIndex, path.join(temp, "original-index")).then(() => path.join(temp, "original-index")).catch(() => null);
    const indexEnv = { GIT_INDEX_FILE: temporaryIndex };
    try { await git(canonicalRoot, ["read-tree", "HEAD"], indexEnv); } catch { await git(canonicalRoot, ["read-tree", "--empty"], indexEnv); }
    await git(canonicalRoot, ["add", "-A", "--", "."], indexEnv);
    const tree = (await git(canonicalRoot, ["write-tree"], indexEnv)).trim();
    const commit = (await git(canonicalRoot, ["commit-tree", tree, "-m", label], { ...indexEnv, GIT_AUTHOR_NAME: "theaihatch", GIT_AUTHOR_EMAIL: "checkpoint@localhost", GIT_COMMITTER_NAME: "theaihatch", GIT_COMMITTER_EMAIL: "checkpoint@localhost" })).trim();
    const files: SnapshotFile[] = [];
    for (const relativePath of await allPaths(canonicalRoot)) {
      const absolute = path.join(canonicalRoot, relativePath);
      try { const bytes = await fs.readFile(absolute); const text = bytes.includes(0) ? bytes.toString("base64") : bytes.toString("utf8"); files.push({ relativePath, content: text, encoding: bytes.includes(0) ? "base64" : "utf8" }); } catch { /* deleted files are represented by absence */ }
    }
    return { id: randomUUID(), root: canonicalRoot, gitCommit: commit, indexPath, files, createdAt: new Date().toISOString() };
  }

  async restore(checkpoint: GitCheckpoint): Promise<void> {
    const root = await fs.realpath(checkpoint.root);
    const current = new Set(await allPaths(root));
    const target = new Set(checkpoint.files.map((file) => file.relativePath));
    for (const relativePath of current) if (!target.has(relativePath)) await fs.rm(path.join(root, relativePath), { force: true });
    for (const file of checkpoint.files) { const absolute = path.join(root, file.relativePath); await fs.mkdir(path.dirname(absolute), { recursive: true }); await fs.writeFile(absolute, file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content, file.encoding === "base64" ? undefined : "utf8"); }
    if (checkpoint.indexPath !== null) await fs.copyFile(checkpoint.indexPath, path.join(root, ".git", "index"));
  }
}
