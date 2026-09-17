import { createHash } from "node:crypto";
import { offsetToPosition, type SesWriter } from "../ses.js";
import { ProcessRunner, type ProcessResult } from "../terminal/process-runner.js";
import { TerminalRecorder } from "../terminal/terminal-recorder.js";
import { WorkspaceTree } from "@theaihatch/workspace";

export interface WorkspaceDemoResult {
  path: string;
  command: ProcessResult;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function runWorkspaceDemo(tree: WorkspaceTree, writer: SesWriter): Promise<WorkspaceDemoResult> {
  const filePath = "theaihatch-demo/hello.ts";
  const stepId = "workspace-demo-edit";
  await writer.append({ type: "step_begin", payload: { stepId, label: "Create a workspace greeting", primaryPath: filePath } });
  let content: string;
  try {
    content = await tree.readFile(filePath);
  } catch {
    content = "";
    await tree.createFile(filePath);
    await writer.append({ type: "file_create", payload: { path: filePath } });
  }
  if (content !== "") {
    await writer.append({ type: "checkpoint", payload: { reason: "cadence", files: [{ path: filePath, content, contentHash: contentHash(content) }] } });
  }
  const insertedText = content === "" ? "export const greeting = \"hello from The AI Hatch\";\n" : "\nexport const hatch = true;\n";
  const position = offsetToPosition(content, content.length);
  const nextContent = content + insertedText;
  await tree.writeFile(filePath, nextContent);
  await writer.append({ type: "edit_insert", payload: { path: filePath, position, text: insertedText } });
  await writer.append({ type: "file_save", payload: { path: filePath, contentHash: contentHash(nextContent) } });
  await writer.append({ type: "step_end", payload: { stepId, outcome: "succeeded", summary: "Workspace file saved" } });

  const executable = process.platform === "win32" ? `"${process.execPath}"` : process.execPath;
  const command = `${executable} -e "console.log('workspace demo complete')"`;
  const commandResult = await new TerminalRecorder(writer, new ProcessRunner(tree.root)).run({ command });
  return { path: filePath, command: commandResult };
}
