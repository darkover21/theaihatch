import { createHash, randomUUID } from "node:crypto";
import { offsetToPosition, positionToOffset, type SesWriter } from "../ses.js";
import type { AgentTool, AgentToolResult } from "@theaihatch/agent";
import type { ProviderToolDefinition } from "@theaihatch/providers";
import { ProcessRunner } from "../terminal/process-runner.js";
import { TerminalRecorder } from "../terminal/terminal-recorder.js";
import { WorkspaceTree } from "@theaihatch/workspace";
import { classifyCommand, requireCommandApproval } from "@theaihatch/safety";

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function objectArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("tool arguments must be an object");
  return Object.fromEntries(Object.entries(value));
}

export function stringArgument(value: Record<string, unknown>, name: string): string {
  const result = value[name];
  if (typeof result !== "string") throw new Error(`${name} must be a string`);
  return result;
}

export function editDelta(before: string, after: string): { start: number; end: number; deletedText: string; insertedText: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd -= 1; afterEnd -= 1; }
  return { start, end: beforeEnd, deletedText: before.slice(start, beforeEnd), insertedText: after.slice(start, afterEnd) };
}

export async function recordCommittedEdit(writer: SesWriter, input: { path: string; before: string; after: string; created: boolean }): Promise<void> {
  if (!writer.currentFiles.has(input.path)) {
    await writer.append({ type: "file_create", payload: { path: input.path } });
    if (!input.created && input.before !== "") await writer.append({ type: "edit_insert", payload: { path: input.path, position: { line: 0, column: 0 }, text: input.before } });
  }
  const delta = editDelta(input.before, input.after);
  const range = { start: offsetToPosition(input.before, delta.start), end: offsetToPosition(input.before, delta.end) };
  if (delta.deletedText === "") await writer.append({ type: "edit_insert", payload: { path: input.path, position: range.start, text: delta.insertedText || " " } });
  else if (delta.insertedText === "") await writer.append({ type: "edit_delete", payload: { path: input.path, range, deletedText: delta.deletedText } });
  else await writer.append({ type: "edit_replace", payload: { path: input.path, range, deletedText: delta.deletedText, insertedText: delta.insertedText } });
  await writer.append({ type: "file_save", payload: { path: input.path, contentHash: hashContent(input.after) } });
}

export function platformToolDefinitions(): ProviderToolDefinition[] {
  return [
    { name: "read_file", description: "Read a workspace file", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
    { name: "edit_file", description: "Replace the requested workspace file content", inputSchema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } },
    { name: "run_command", description: "Run a workspace-rooted command", inputSchema: { type: "object", required: ["command"], properties: { command: { type: "string" }, cwd: { type: "string" } } } }
  ];
}

export function createWorkspaceTools(tree: WorkspaceTree, writer: SesWriter): AgentTool[] {
  const terminal = new TerminalRecorder(writer, new ProcessRunner(tree.root));
  return [
    { name: "read_file", execute: async (argumentsValue): Promise<AgentToolResult> => ({ ok: true, content: await tree.readFile(tree.normalize(stringArgument(objectArguments(argumentsValue), "path"))) }) },
    { name: "edit_file", execute: async (argumentsValue): Promise<AgentToolResult> => {
      const argumentsObject = objectArguments(argumentsValue);
      const filePath = tree.normalize(stringArgument(argumentsObject, "path"));
      const nextContent = stringArgument(argumentsObject, "content");
      let before = "";
      let exists = true;
      try { before = await tree.readFile(filePath); } catch { exists = false; }
      if (!exists) { await tree.createFile(filePath); await writer.append({ type: "file_create", payload: { path: filePath } }); }
      await tree.writeFile(filePath, nextContent);
      await recordCommittedEdit(writer, { path: filePath, before, after: nextContent, created: !exists });
      return { ok: true, content: { path: filePath, contentHash: hashContent(nextContent) } };
    } },
    { name: "run_command", execute: async (argumentsValue): Promise<AgentToolResult> => {
      const argumentsObject = objectArguments(argumentsValue);
      const command = stringArgument(argumentsObject, "command");
      const cwd = typeof argumentsObject.cwd === "string" ? argumentsObject.cwd : tree.root.canonicalPath;
      const decision = classifyCommand(command, cwd);
      try { requireCommandApproval(decision, false); } catch (error) { return { ok: false, content: error instanceof Error ? error.message : String(error), errorCode: "approval_required" }; }
      const result = await terminal.run({ command, ...(typeof argumentsObject.cwd === "string" ? { cwd: argumentsObject.cwd } : {}), commandId: randomUUID() });
      return { ok: result.status === "exited", content: result, ...(result.status === "exited" ? {} : { errorCode: result.status }) };
    } }
  ];
}

export function validateEditContent(before: string, after: string): void {
  const delta = editDelta(before, after);
  if (delta.deletedText === "" && delta.insertedText === "") throw new Error("edit contains no change");
  if (positionToOffset(before, offsetToPosition(before, delta.start)) !== delta.start) throw new Error("invalid edit position");
}
