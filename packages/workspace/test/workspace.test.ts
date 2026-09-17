import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeWorkspacePath, openWorkspaceRoot, WorkspacePathError } from "../src/paths.js";
import { WorkspaceTree } from "../src/tree.js";
import { WorkspaceWatcher } from "../src/watcher.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-workspace-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "hidden"), { recursive: true });
  await fs.mkdir(path.join(root, ".git", "objects"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n*.log\n!keep.log\n", "utf8");
  await fs.writeFile(path.join(root, "src", "z.ts"), "export const z = 1;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await fs.writeFile(path.join(root, "ignored.txt"), "ignored\n", "utf8");
  await fs.writeFile(path.join(root, "discard.log"), "ignored\n", "utf8");
  await fs.writeFile(path.join(root, "keep.log"), "visible\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("workspace", () => {
  it("REQ-WKS-001: opens only a readable local folder", async () => {
    const root = await fixture();
    const opened = await openWorkspaceRoot(root);
    expect(opened.canonicalPath).toBe(await fs.realpath(root));
    await expect(openWorkspaceRoot(path.join(root, "missing"))).rejects.toThrow(/missing or unreadable/u);
  });

  it("REQ-WKS-002: lists direct children folder-first and name-stably", async () => {
    const root = await fixture();
    const entries = await (await WorkspaceTree.open(root)).list("src");
    expect(entries.map((entry) => entry.name)).toEqual(["nested", "a.ts", "z.ts"]);
  });

  it("REQ-WKS-003: applies .gitignore and mandatory ignores", async () => {
    const root = await fixture();
    const entries = await (await WorkspaceTree.open(root)).list(".");
    expect(entries.map((entry) => entry.name)).not.toEqual(expect.arrayContaining(["ignored.txt", "discard.log", ".git", "node_modules"]));
    expect(entries.map((entry) => entry.name)).toContain("keep.log");
  });

  it("REQ-WKS-006: normalizes safe relative slash paths and rejects traversal", async () => {
    const root = await fixture();
    const opened = await openWorkspaceRoot(root);
    expect(normalizeWorkspacePath(opened, path.join(root, "src", "a.ts"))).toBe("src/a.ts");
    expect(normalizeWorkspacePath(opened, "src\\nested\\..\\a.ts")).toBe("src/a.ts");
    expect(() => normalizeWorkspacePath(opened, "../../outside.txt")).toThrow(WorkspacePathError);
  });

  it("REQ-WKS-005: watches external create, modify, delete, and rename operations", async () => {
    const root = await fixture();
    const tree = await WorkspaceTree.open(root);
    const watcher = new WorkspaceWatcher(tree);
    const changes: Array<{ kind: string; path: string; previousPath?: string }> = [];
    const unsubscribe = watcher.subscribe((change) => changes.push(change));
    await watcher.start();
    await fs.writeFile(path.join(root, "watched.txt"), "one\n", "utf8");
    await waitFor(() => changes.some((change) => change.kind === "create" && change.path === "watched.txt"));
    await fs.writeFile(path.join(root, "watched.txt"), "two\n", "utf8");
    await waitFor(() => changes.some((change) => change.kind === "modify" && change.path === "watched.txt"));
    await fs.rename(path.join(root, "watched.txt"), path.join(root, "renamed.txt"));
    await waitFor(() => changes.some((change) => change.kind === "rename" && change.path === "renamed.txt"));
    await fs.unlink(path.join(root, "renamed.txt"));
    await waitFor(() => changes.some((change) => change.kind === "delete" && change.path === "renamed.txt"));
    unsubscribe();
    await watcher.stop();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(predicate()).toBe(true);
}
