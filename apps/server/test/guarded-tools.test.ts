import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewGate } from "@theaihatch/agent";
import { diffFile } from "@theaihatch/review";
import { DryRunRecorder } from "@theaihatch/safety";
import { ReviewRepository, SafetyAuditRepository } from "@theaihatch/storage";
import { SesReader, SesWriter } from "@theaihatch/ses";
import { WorkspaceTree } from "@theaihatch/workspace";
import { ApprovalBroker } from "../src/agent/approval-broker.js";
import { createGuardedWorkspaceTools } from "../src/agent/guarded-tools.js";

const temporaryDirectories: string[] = [];
const closers: Array<() => void | Promise<void>> = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(closers.splice(0).map(async (close) => close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture(options: { dryRun?: boolean; reviewMode?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-guarded-tools-"));
  const session = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-guarded-session-"));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-guarded-data-"));
  temporaryDirectories.push(root, session, data);
  await fs.writeFile(path.join(root, "a.ts"), "before", "utf8");
  const tree = await WorkspaceTree.open(root);
  const writer = await SesWriter.open(session);
  const approvals = new ApprovalBroker();
  const proposals = new DryRunRecorder(options.dryRun ?? false);
  const reviews = new ReviewRepository(data);
  const audits = new SafetyAuditRepository(data);
  closers.push(() => reviews.close(), () => audits.close());
  const tools = await createGuardedWorkspaceTools({ operationId: "operation-1", checkpointId: "checkpoint-1", tree, writer, dryRun: options.dryRun ?? false, reviewMode: options.reviewMode ?? false, approvals, reviews, audits, reviewGate: new ReviewGate(), proposals });
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`missing tool: ${name}`);
    return found;
  };
  return { root, session, tree, writer, approvals, proposals, reviews, audits, tool };
}

async function events(session: string, writer: SesWriter): Promise<Array<{ type: string; payload: unknown }>> {
  await writer.close();
  const reader = await SesReader.open(path.join(session, "events.jsonl"));
  return (await reader.readRange(0, reader.headSeq)).events;
}

describe("guarded workspace tools", () => {
  it("REQ-SAF-006: dry-run edit emits a proposed diff without changing bytes", async () => {
    const context = await fixture({ dryRun: true });

    await expect(context.tool("edit_file").execute({ path: "a.ts", content: "after" }, signal)).resolves.toMatchObject({ ok: true });

    expect(await context.tree.readFile("a.ts")).toBe("before");
    expect(context.proposals.actions).toEqual([expect.objectContaining({ kind: "file", path: "a.ts" })]);
    expect((await events(context.session, context.writer)).map((event) => event.type)).toContain("diff_marker");
  });

  it("REQ-SAF-005: rejects a command cwd outside the workspace before spawning", async () => {
    const context = await fixture();

    await expect(context.tool("run_command").execute({ command: "echo x", cwd: "../outside" }, signal)).resolves.toMatchObject({ ok: false, errorCode: "path_denied" });

    expect((await events(context.session, context.writer)).map((event) => event.type)).not.toContain("terminal_command");
    expect(context.audits.list("operation-1")).toEqual([expect.objectContaining({ action: "command", decision: "denied" })]);
  });

  it("REQ-SAF-001: rejects a new file below a symlink that escapes the workspace", async () => {
    const context = await fixture({ dryRun: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-guarded-outside-"));
    temporaryDirectories.push(outside);
    await fs.symlink(outside, path.join(context.root, "escape"), "junction");

    await expect(context.tool("edit_file").execute({ path: "escape/new.ts", content: "after" }, signal)).resolves.toMatchObject({ ok: false, errorCode: "path_denied" });

    await expect(fs.access(path.join(outside, "new.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(context.proposals.actions).toEqual([]);
    expect(context.audits.list("operation-1")).toEqual([expect.objectContaining({ action: "file", decision: "denied" })]);
  });

  it("REQ-REV-002 and REQ-REV-003: writes an accepted reviewed edit after persisting its snapshot", async () => {
    const context = await fixture({ reviewMode: true });
    const pending = context.tool("edit_file").execute({ path: "a.ts", content: "after" }, signal);

    await vi.waitFor(() => expect(context.approvals.pending("operation-1")?.kind).toBe("review"));
    const approval = context.approvals.pending("operation-1");
    if (approval?.kind !== "review") throw new Error("missing review snapshot");
    const snapshotId = approval.snapshotId;
    const snapshot = context.reviews.listSnapshots("operation-1")[0];
    if (snapshot === undefined) throw new Error("missing persisted review");
    expect(snapshot.checkpointId).toBe("checkpoint-1");
    context.approvals.resolveReview("operation-1", snapshot.files[0]?.hunks.map((hunk) => ({ hunkId: hunk.id, decision: "accepted", actor: "user" })) ?? []);

    await expect(pending).resolves.toMatchObject({ ok: true, content: expect.objectContaining({ snapshotId }) });
    expect(await context.tree.readFile("a.ts")).toBe("after");
    expect(context.reviews.listSnapshots("operation-1")[0]?.decisions).toEqual([expect.objectContaining({ decision: "accepted" })]);
  });

  it("REQ-SAF-001: returns a controlled denial when the requested edit target is a directory", async () => {
    const context = await fixture();
    await fs.mkdir(path.join(context.root, "directory"));

    await expect(context.tool("edit_file").execute({ path: "directory", content: "after" }, signal)).resolves.toMatchObject({ ok: false, errorCode: "read_failed" });

    expect(context.audits.list("operation-1")).toEqual([expect.objectContaining({ action: "file", decision: "denied", detail: expect.stringContaining("read_failed") })]);
  });

  it("REQ-SAF-007: audits no-op and invalid edit inputs as controlled denials", async () => {
    const context = await fixture();

    await expect(context.tool("edit_file").execute({ path: "a.ts", content: "before" }, signal)).resolves.toMatchObject({ ok: false, errorCode: "no_change" });
    await expect(context.tool("edit_file").execute({ path: "a.ts" }, signal)).resolves.toMatchObject({ ok: false, errorCode: "invalid_arguments" });

    expect(context.audits.list("operation-1")).toEqual([
      expect.objectContaining({ action: "file", decision: "denied", detail: expect.stringContaining("no_change") }),
      expect.objectContaining({ action: "file", decision: "denied", detail: expect.stringContaining("invalid_arguments") })
    ]);
  });

  it("REQ-REV-004: returns rejected review feedback without writing the proposed edit", async () => {
    const context = await fixture({ reviewMode: true });
    const pending = context.tool("edit_file").execute({ path: "a.ts", content: "after" }, signal);

    await vi.waitFor(() => expect(context.approvals.pending("operation-1")?.kind).toBe("review"));
    const hunk = diffFile("a.ts", "before", "after").hunks[0];
    if (hunk === undefined) throw new Error("missing review hunk");
    context.approvals.resolveReview("operation-1", [{ hunkId: hunk.id, decision: "rejected", actor: "user", feedback: "keep before" }]);

    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: "review_rejected", content: expect.objectContaining({ feedback: "keep before" }) });
    expect(await context.tree.readFile("a.ts")).toBe("before");
  });

  it("REQ-SAF-004: denied destructive commands do not spawn and are audited", async () => {
    const context = await fixture();
    const pending = context.tool("run_command").execute({ command: "del a.ts" }, signal);

    await vi.waitFor(() => expect(context.approvals.pending("operation-1")?.kind).toBe("command"));
    const decision = context.approvals.pending("operation-1");
    if (decision?.kind !== "command") throw new Error("missing command approval");
    context.approvals.resolveCommand("operation-1", { command: decision.decision.exactCommand, cwd: decision.decision.cwd, approved: false });

    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: "command_denied" });
    expect((await events(context.session, context.writer)).map((event) => event.type)).not.toContain("terminal_command");
    expect(context.audits.list("operation-1")).toEqual([expect.objectContaining({ action: "command", decision: "denied" })]);
  });

  it("REQ-SAF-006: dry-run commands are recorded without a process", async () => {
    const context = await fixture({ dryRun: true });

    await expect(context.tool("run_command").execute({ command: "echo proposed" }, signal)).resolves.toMatchObject({ ok: true, content: expect.objectContaining({ suppressed: true }) });

    expect(context.proposals.actions).toEqual([expect.objectContaining({ kind: "command", command: "echo proposed" })]);
    expect((await events(context.session, context.writer)).map((event) => event.type)).not.toContain("terminal_command");
    expect(context.audits.list("operation-1")).toEqual([expect.objectContaining({ action: "command", decision: "suppressed" })]);
  });
});
