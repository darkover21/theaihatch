import type { AgentTool, AgentToolResult, ReviewGate } from "@theaihatch/agent";
import { diffFile, type FileDiff, type ReviewHunk } from "@theaihatch/review";
import { classifyCommand, createPathPolicy, createShellPolicy, DryRunRecorder, type PathPolicy } from "@theaihatch/safety";
import { ReviewRepository, SafetyAuditRepository } from "@theaihatch/storage";
import { WorkspaceTree } from "@theaihatch/workspace";
import type { SesWriter } from "../ses.js";
import { ProcessRunner } from "../terminal/process-runner.js";
import { TerminalRecorder } from "../terminal/terminal-recorder.js";
import { ApprovalBroker } from "./approval-broker.js";
import { hashContent, objectArguments, recordCommittedEdit, stringArgument } from "./ses-recorder.js";

export interface GuardedToolContext {
  operationId: string;
  checkpointId: string;
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

async function readBefore(tree: WorkspaceTree, filePath: string): Promise<{ before: string; created: boolean } | { error: string }> {
  try { return { before: await tree.readFile(filePath), created: false }; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { before: "", created: true };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function resolveFilePath(context: GuardedToolContext, pathPolicy: PathPolicy, argumentsValue: unknown, contentRequired: boolean): Promise<{ filePath: string; after?: string } | AgentToolResult> {
  let argumentsObject: Record<string, unknown>;
  let requestedPath: string;
  let after: string | undefined;
  try {
    argumentsObject = objectArguments(argumentsValue);
    requestedPath = stringArgument(argumentsObject, "path");
    if (contentRequired) after = stringArgument(argumentsObject, "content");
  } catch (error) {
    audit(context, "file", "denied", { reason: "invalid_arguments" });
    return denied(error instanceof Error ? error.message : String(error), "invalid_arguments");
  }
  let filePath: string;
  try { filePath = context.tree.normalize(await pathPolicy.resolve(requestedPath)); } catch (error) {
    audit(context, "file", "denied", { reason: "path_denied", path: requestedPath });
    return denied(error instanceof Error ? error.message : String(error), "path_denied");
  }
  return { filePath, ...(after === undefined ? {} : { after }) };
}

async function readFile(context: GuardedToolContext, pathPolicy: PathPolicy, argumentsValue: unknown): Promise<AgentToolResult> {
  const resolved = await resolveFilePath(context, pathPolicy, argumentsValue, false);
  if ("ok" in resolved) return resolved;
  try { return { ok: true, content: await context.tree.readFile(resolved.filePath) }; } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit(context, "file", "denied", { reason: "read_failed", path: resolved.filePath, message });
    return denied(message, "read_failed");
  }
}

async function editFile(context: GuardedToolContext, pathPolicy: PathPolicy, argumentsValue: unknown): Promise<AgentToolResult> {
  const resolved = await resolveFilePath(context, pathPolicy, argumentsValue, true);
  if ("ok" in resolved) return resolved;
  const { filePath, after } = resolved;
  if (after === undefined) {
    audit(context, "file", "denied", { reason: "invalid_arguments", path: filePath });
    return denied("content must be a string", "invalid_arguments");
  }
  const beforeResult = await readBefore(context.tree, filePath);
  if ("error" in beforeResult) {
    audit(context, "file", "denied", { reason: "read_failed", path: filePath, message: beforeResult.error });
    return denied(beforeResult.error, "read_failed");
  }
  const { before, created } = beforeResult;
  const diff = diffFile(filePath, before, after);
  if (diff.hunks.length === 0) {
    audit(context, "file", "denied", { reason: "no_change", path: filePath });
    return denied("edit contains no change", "no_change");
  }
  await appendDiffMarkers(context, diff);
  if (context.dryRun) {
    context.proposals.file(filePath, "edit proposed");
    audit(context, "file", "suppressed", { path: filePath, diff });
    return { ok: true, content: { path: filePath, proposed: true, diff } };
  }

  let snapshotId: string | undefined;
  if (context.reviewMode) {
    const snapshot = context.reviews.createSnapshot({ runId: context.operationId, checkpointId: context.checkpointId, files: [diff] });
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

  try { await context.tree.writeFile(filePath, after); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit(context, "file", "denied", { reason: "write_failed", path: filePath, message });
    return denied(message, "write_failed");
  }
  await recordCommittedEdit(context.writer, { path: filePath, before, after, created });
  return { ok: true, content: { path: filePath, contentHash: hashContent(after), ...(snapshotId === undefined ? {} : { snapshotId }) } };
}

async function runCommand(context: GuardedToolContext, argumentsValue: unknown, signal: AbortSignal): Promise<AgentToolResult> {
  let argumentsObject: Record<string, unknown>;
  let command: string;
  try { argumentsObject = objectArguments(argumentsValue); command = stringArgument(argumentsObject, "command"); } catch (error) {
    audit(context, "command", "denied", { reason: "invalid_arguments" });
    return denied(error instanceof Error ? error.message : String(error), "invalid_arguments");
  }
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
  const result = await terminal.run({ command, cwd: context.tree.normalize(requestedCwd), signal });
  return { ok: result.status === "exited", content: result, ...(result.status === "exited" ? {} : { errorCode: result.status }) };
}

export async function createGuardedWorkspaceTools(context: GuardedToolContext): Promise<AgentTool[]> {
  const pathPolicy = await createPathPolicy(context.tree.root.canonicalPath);
  return [
    { name: "read_file", execute: (argumentsValue) => readFile(context, pathPolicy, argumentsValue) },
    { name: "edit_file", execute: (argumentsValue) => editFile(context, pathPolicy, argumentsValue) },
    { name: "run_command", execute: (argumentsValue, signal) => runCommand(context, argumentsValue, signal) }
  ];
}
