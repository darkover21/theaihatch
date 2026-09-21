import { createHash, randomUUID } from "node:crypto";
import { offsetToPosition, positionToOffset, type SesAppender } from "../ses.js";
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

export async function recordCommittedEdit(writer: SesAppender, input: { path: string; before: string; after: string; created: boolean }): Promise<void> {
  if (!writer.currentFiles.has(input.path) || writer.currentFiles.get(input.path) === null) {
    await writer.append({ type: "file_create", payload: { path: input.path } });
    if (!input.created && input.before !== "") {
      if (input.before.length <= 2000 && input.before.split("\n").length <= 80) {
        const files = [...writer.currentFiles].map(([path, content]) => ({ path, content, contentHash: content === null ? null : hashContent(content) }));
        const index = files.findIndex((file) => file.path === input.path);
        if (index >= 0) files[index] = { path: input.path, content: input.before, contentHash: hashContent(input.before) };
        await writer.append({ type: "checkpoint", payload: { reason: "hydration", files } });
      } else {
        await writer.append({ type: "edit_insert", payload: { path: input.path, position: { line: 0, column: 0 }, text: input.before } });
      }
    }
  }
  const delta = editDelta(input.before, input.after);
  const range = { start: offsetToPosition(input.before, delta.start), end: offsetToPosition(input.before, delta.end) };
  await writer.append({ type: "file_open", payload: { path: input.path, preview: false } });
  await writer.append({ type: "cursor_move", payload: { path: input.path, position: range.start } });
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

export function createWorkspaceTools(tree: WorkspaceTree, writer: SesAppender): AgentTool[] {
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
      const stepId = `edit-${randomUUID()}`;
      await writer.append({ type: "step_begin", payload: { stepId, label: `Edit ${filePath}`, primaryPath: filePath } });
      try {
        if (!exists) { await tree.createFile(filePath); await writer.append({ type: "file_create", payload: { path: filePath } }); }
        await tree.writeFile(filePath, nextContent);
        await recordCommittedEdit(writer, { path: filePath, before, after: nextContent, created: !exists });
        await writer.append({ type: "step_end", payload: { stepId, outcome: "succeeded" } });
      } catch (error) {
        await writer.append({ type: "step_end", payload: { stepId, outcome: "failed" } });
        throw error;
      }
      return { ok: true, content: { path: filePath, contentHash: hashContent(nextContent) } };
    } },
    { name: "run_command", execute: async (argumentsValue): Promise<AgentToolResult> => {
      const argumentsObject = objectArguments(argumentsValue);
      const command = stringArgument(argumentsObject, "command");
      const cwd = typeof argumentsObject.cwd === "string" ? argumentsObject.cwd : tree.root.canonicalPath;
      const decision = classifyCommand(command, cwd);
      try { requireCommandApproval(decision, false); } catch (error) { return { ok: false, content: error instanceof Error ? error.message : String(error), errorCode: "approval_required" }; }
      const stepId = `command-${randomUUID()}`;
      await writer.append({ type: "step_begin", payload: { stepId, label: `Run ${command}` } });
      const result = await terminal.run({ command, ...(typeof argumentsObject.cwd === "string" ? { cwd: argumentsObject.cwd } : {}), commandId: randomUUID() });
      await writer.append({ type: "step_end", payload: { stepId, outcome: result.status === "exited" ? "succeeded" : "failed" } });
      return { ok: result.status === "exited", content: result, ...(result.status === "exited" ? {} : { errorCode: result.status }) };
    } }
  ];
}

export function validateEditContent(before: string, after: string): void {
  const delta = editDelta(before, after);
  if (delta.deletedText === "" && delta.insertedText === "") throw new Error("edit contains no change");
  if (positionToOffset(before, offsetToPosition(before, delta.start)) !== delta.start) throw new Error("invalid edit position");
}
