import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { classifyCommand, requireCommandApproval } from "../src/command-policy.js";
import { createPathPolicy } from "../src/path-policy.js";
import { DryRunRecorder } from "../src/dry-run.js";
import { GitCheckpointStore } from "../src/git-checkpoint.js";
const run = promisify(execFile);
const git = process.env.GIT_EXECUTABLE ?? (process.platform === "win32" ? path.join(process.env.ProgramFiles ?? `${path.parse(process.execPath).root}Program Files`, "Git", "cmd", "git.exe") : "git");

describe("safety", () => {
  it("REQ-SAF-001: rejects traversal and symlink escape", async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-safe-")); const outside = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-out-")); await fs.writeFile(path.join(outside, "secret"), "x"); const policy = await createPathPolicy(root); await expect(policy.assert("../secret")).rejects.toThrow(); });
  it("REQ-SAF-004 and REQ-SAF-005: requires exact destructive approval", () => { const decision = classifyCommand("git reset --hard", "C:\\workspace"); expect(decision.destructive).toBe(true); expect(() => requireCommandApproval(decision, false)).toThrow(/approval required/); });
  it("REQ-SAF-006: records proposed actions without running them", () => { const dryRun = new DryRunRecorder(); dryRun.file("a.ts", "edit proposed"); dryRun.command("rm a.ts"); expect(dryRun.actions).toHaveLength(2); });
  it("REQ-SAF-002 and REQ-SAF-003: restores tracked, staged, untracked, and deleted state", async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-git-")); await run(git, ["init", "-q"], { cwd: root }); await run(git, ["config", "user.email", "test@example.invalid"], { cwd: root }); await run(git, ["config", "user.name", "Test"], { cwd: root }); await fs.writeFile(path.join(root, "tracked.txt"), "base"); await fs.writeFile(path.join(root, "deleted.txt"), "keep"); await run(git, ["add", "."], { cwd: root }); await run(git, ["commit", "-qm", "base"], { cwd: root }); await fs.writeFile(path.join(root, "tracked.txt"), "staged"); await run(git, ["add", "tracked.txt"], { cwd: root }); await fs.writeFile(path.join(root, "untracked.txt"), "new"); await fs.rm(path.join(root, "deleted.txt")); const checkpoint = await new GitCheckpointStore().create(root); await fs.writeFile(path.join(root, "tracked.txt"), "changed"); await fs.writeFile(path.join(root, "extra.txt"), "extra"); await new GitCheckpointStore().restore(checkpoint); expect(await fs.readFile(path.join(root, "tracked.txt"), "utf8")).toBe("staged"); expect(await fs.readFile(path.join(root, "untracked.txt"), "utf8")).toBe("new"); await expect(fs.access(path.join(root, "deleted.txt"))).rejects.toThrow(); await expect(fs.access(path.join(root, "extra.txt"))).rejects.toThrow(); });
});
