import { z } from "zod";

export const platformToolDefinitions = [
  { name: "open_file", description: "Open a workspace file in the editor", inputSchema: z.object({ path: z.string().min(1) }) },
  { name: "edit_file", description: "Replace workspace file content", inputSchema: z.object({ path: z.string().min(1), content: z.string() }) },
  { name: "save_file", description: "Save a workspace file", inputSchema: z.object({ path: z.string().min(1) }) },
  { name: "run_command", description: "Run a workspace command", inputSchema: z.object({ command: z.string().min(1), cwd: z.string().optional() }) },
  { name: "animate_step", description: "Append a visible animation step", inputSchema: z.object({ label: z.string().min(1) }) }
] as const;

export type PlatformToolName = (typeof platformToolDefinitions)[number]["name"];
export type PlatformToolCall = { name: PlatformToolName; arguments: Record<string, unknown> };
export interface PlatformToolHandlers { open_file: (input: { path: string }) => Promise<unknown>; edit_file: (input: { path: string; content: string }) => Promise<unknown>; save_file: (input: { path: string }) => Promise<unknown>; run_command: (input: { command: string; cwd?: string }) => Promise<unknown>; animate_step: (input: { label: string }) => Promise<unknown>; }

export function publicToolSchemas(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> { return platformToolDefinitions.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.name === "edit_file" ? { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } : tool.name === "run_command" ? { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] } : tool.name === "animate_step" ? { type: "object", properties: { label: { type: "string" } }, required: ["label"] } : { type: "object", properties: { path: { type: "string" } }, required: ["path"] } })); }

export function parsePlatformTool(name: string, value: unknown): PlatformToolCall | { error: string } {
  const definition = platformToolDefinitions.find((tool) => tool.name === name);
  if (definition === undefined) return { error: `unknown platform tool: ${name}` };
  const parsed = definition.inputSchema.safeParse(value);
  return parsed.success ? { name: definition.name, arguments: parsed.data } : { error: parsed.error.message };
}
