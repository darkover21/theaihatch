import type { AgentTool, AgentToolResult, ReviewGate } from "@theaihatch/agent";
import { diffFile, type FileDiff, type ReviewHunk } from "@theaihatch/review";
import { classifyCommand, createShellPolicy, DryRunRecorder } from "@theaihatch/safety";
import { ReviewRepository, SafetyAuditRepository } from "@theaihatch/storage";
import { WorkspaceTree } from "@theaihatch/workspace";
import type { SesWriter } from "../ses.js";
import { ProcessRunner } from "../terminal/process-runner.js";
import { TerminalRecorder } from "../terminal/terminal-recorder.js";
import { ApprovalBroker } from "./approval-broker.js";
import { hashContent, objectArguments, recordCommittedEdit, stringArgument } from "./ses-recorder.js";

export interface GuardedToolContext {
  operationId: string;
  tree: WorkspaceTree;
  writer: SesWriter;
  dryRun: boolean;
  reviewMode: boolean;
  approvals: ApprovalBroker;
  reviews: ReviewRepository;
  audits: SafetyAuditRepository;
  reviewGate: ReviewGate;
  proposals: DryRunRecorder;
}

function audit(context: GuardedToolContext, action: string, decision: "approved" | "denied" | "recorded" | "suppressed", detail: unknown): void {
  context.audits.record({ runId: context.operationId, action, decision, detail: JSON.stringify(detail) });
}

function denied(content: string, errorCode: string): AgentToolResult {
  return { ok: false, content, errorCode };
}

function hunkRange(before: string, hunk: ReviewHunk): { start: { line: number; column: number }; end: { line: number; column: number } } {
  const line = Math.max(0, hunk.startLine - 1);
  const span = hunk.beforeLines.length === 0 ? 0 : hunk.beforeLines.length - 1;
  void before;
  return { start: { line, column: 0 }, end: { line: line + span, column: hunk.beforeLines.length === 0 ? 0 : hunk.beforeLines.at(-1)?.length ?? 0 } };
}

async function appendDiffMarkers(context: GuardedToolContext, diff: FileDiff): Promise<void> {
  for (const hunk of diff.hunks) {
    const kind = hunk.beforeLines.length === 0 ? "added" : hunk.afterLines.length === 0 ? "deleted" : "modified";
    await context.writer.append({ type: "diff_marker", payload: { path: diff.path, range: hunkRange(diff.before, hunk), kind, hunkId: hunk.id } });
  }
}

async function readBefore(tree: WorkspaceTree, filePath: string): Promise<{ before: string; created: boolean }> {
  try { return { before: await tree.readFile(filePath), created: false }; } catch { return { before: "", created: true }; }
}

async function editFile(context: GuardedToolContext, argumentsValue: unknown): Promise<AgentToolResult> {
  const argumentsObject = objectArguments(argumentsValue);
  let filePath: string;
  try { filePath = context.tree.normalize(stringArgument(argumentsObject, "path")); } catch (error) {
    audit(context, "file", "denied", { reason: "path_denied", path: argumentsObject.path });
    return denied(error instanceof Error ? error.message : String(error), "path_denied");
  }
  const after = stringArgument(argumentsObject, "content");
  const { before, created } = await readBefore(context.tree, filePath);
  const diff = diffFile(filePath, before, after);
  if (diff.hunks.length === 0) return denied("edit contains no change", "no_change");
  await appendDiffMarkers(context, diff);
  if (context.dryRun) {
    context.proposals.file(filePath, "edit proposed");
    audit(context, "file", "suppressed", { path: filePath, diff });
    return { ok: true, content: { path: filePath, proposed: true, diff } };
  }

  let snapshotId: string | undefined;
  if (context.reviewMode) {
    const snapshot = context.reviews.createSnapshot({ runId: context.operationId, checkpointId: context.operationId, files: [diff] });
    snapshotId = snapshot.id;
    const decisions = await context.approvals.requestReview({ operationId: context.operationId, snapshotId, hunks: snapshot.files.flatMap((file) => file.hunks) });
    context.reviews.resolveSnapshot(snapshotId, decisions);
    const rejected = decisions.filter((decision) => decision.decision === "rejected");
    if (rejected.length > 0) {
      const feedback = rejected.map((decision) => decision.feedback).find((value): value is string => value !== undefined) ?? "edit rejected";
      context.reviewGate.resolve(rejected.map((decision) => ({ path: filePath, hunkId: decision.hunkId, decision: "rejected", ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }) })));
      audit(context, "file", "denied", { path: filePath, snapshotId, decisions });
      return { ok: false, content: { path: filePath, snapshotId, feedback }, errorCode: "review_rejected" };
    }
    audit(context, "file", "approved", { path: filePath, snapshotId, decisions });
  }

  await context.tree.writeFile(filePath, after);
  await recordCommittedEdit(context.writer, { path: filePath, before, after, created });
  return { ok: true, content: { path: filePath, contentHash: hashContent(after), ...(snapshotId === undefined ? {} : { snapshotId }) } };
}

async function runCommand(context: GuardedToolContext, argumentsValue: unknown): Promise<AgentToolResult> {
  const argumentsObject = objectArguments(argumentsValue);
  const command = stringArgument(argumentsObject, "command");
  const requestedCwd = typeof argumentsObject.cwd === "string" ? argumentsObject.cwd : ".";
  const shellPolicy = await createShellPolicy(context.tree.root.canonicalPath);
  let cwd: string;
  try { cwd = await shellPolicy.workingDirectory(requestedCwd); } catch (error) {
    audit(context, "command", "denied", { reason: "path_denied", command, cwd: requestedCwd });
    return denied(error instanceof Error ? error.message : String(error), "path_denied");
  }
  const decision = classifyCommand(command, cwd);
  if (decision.destructive) {
    const approval = await context.approvals.requestCommand({ operationId: context.operationId, decision });
    if (!approval.approved) {
      audit(context, "command", "denied", { command, cwd, reason: decision.reason });
      return denied("command approval denied", "command_denied");
    }
    audit(context, "command", "approved", { command, cwd, reason: decision.reason });
  }
  if (context.dryRun) {
    context.proposals.command(command);
    audit(context, "command", "suppressed", { command, cwd });
    return { ok: true, content: { command, cwd, suppressed: true } };
  }
  const terminal = new TerminalRecorder(context.writer, new ProcessRunner(context.tree.root));
  const result = await terminal.run({ command, cwd: context.tree.normalize(requestedCwd) });
  return { ok: result.status === "exited", content: result, ...(result.status === "exited" ? {} : { errorCode: result.status }) };
}

export async function createGuardedWorkspaceTools(context: GuardedToolContext): Promise<AgentTool[]> {
  return [
    { name: "read_file", execute: async (argumentsValue): Promise<AgentToolResult> => ({ ok: true, content: await context.tree.readFile(context.tree.normalize(stringArgument(objectArguments(argumentsValue), "path"))) }) },
    { name: "edit_file", execute: (argumentsValue) => editFile(context, argumentsValue) },
    { name: "run_command", execute: (argumentsValue) => runCommand(context, argumentsValue) }
  ];
}
