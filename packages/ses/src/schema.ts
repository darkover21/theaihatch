import { z } from "zod";

export type SessionId = string;
export type StepId = string;
export type ToolCallId = string;
export type TerminalCommandId = string;
export type WorkspacePath = string;

export interface Position {
  line: number;
  column: number;
}

export interface TextRange {
  start: Position;
  end: Position;
}

export type StepOutcome = "succeeded" | "failed" | "cancelled" | "denied";
export type DiffKind = "added" | "modified" | "deleted";
export type TerminalStream = "stdout" | "stderr";

export interface SesPayloadMap {
  workspace_open: { rootName: string; canonicalRoot: string };
  file_open: { path: WorkspacePath; preview: boolean };
  file_close: { path: WorkspacePath };
  tab_focus: { path: WorkspacePath };
  cursor_move: { path: WorkspacePath; position: Position };
  selection_change: { path: WorkspacePath; selections: TextRange[]; primary: number };
  scroll: { path: WorkspacePath; scrollTop: number; scrollLeft: number };
  edit_insert: { path: WorkspacePath; position: Position; text: string };
  edit_delete: { path: WorkspacePath; range: TextRange; deletedText: string };
  edit_replace: { path: WorkspacePath; range: TextRange; deletedText: string; insertedText: string };
  file_create: { path: WorkspacePath };
  file_save: { path: WorkspacePath; contentHash: string };
  file_delete: { path: WorkspacePath };
  file_rename: { from: WorkspacePath; to: WorkspacePath };
  terminal_command: { commandId: TerminalCommandId; command: string; cwd: WorkspacePath | "."; shell: string };
  terminal_output: {
    commandId: TerminalCommandId;
    stream: TerminalStream;
    chunk: string;
    eof: boolean;
    exitCode?: number;
    signal?: string;
  };
  agent_thought: { text: string; visibility: "summary" | "hidden" };
  agent_tool_call: { callId: ToolCallId; server?: string; tool: string; arguments: unknown };
  agent_tool_result: { callId: ToolCallId; ok: boolean; content: unknown; errorCode?: string };
  step_begin: { stepId: StepId; label: string; primaryPath?: WorkspacePath };
  step_end: { stepId: StepId; outcome: StepOutcome; summary?: string };
  checkpoint: {
    reason: "cadence" | "final";
    files: Array<{ path: WorkspacePath; content: string | null; contentHash: string | null }>;
  };
  diff_marker: { path: WorkspacePath; range: TextRange; kind: DiffKind; hunkId: string };
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    source: "ses" | "playback" | "agent" | "provider" | "mcp" | "workspace" | "terminal";
    details?: unknown;
  };
}

export type SesEventType = keyof SesPayloadMap;

export type SesEvent<T extends SesEventType = SesEventType> = {
  [K in T]: {
    seq: number;
    t: number;
    type: K;
    payload: SesPayloadMap[K];
  };
}[T];

export type AnySesEvent = SesEvent;
export type SesEventInput<T extends SesEventType = SesEventType> = {
  [K in T]: { type: K; payload: SesPayloadMap[K]; seq?: number; t?: number };
}[T];

export interface SessionMetadata {
  id: SessionId;
  workspacePath: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  status: "created" | "running" | "completed" | "cancelled" | "failed";
  streamPath: string;
  headSeq: number;
  durationMs: number;
  providerId: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  integrity: "unchecked" | "valid" | "recovered" | "corrupt";
}

const pathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(value), "path must be relative")
  .refine((value) => !value.split("/").some((part) => part === ".." || part.length === 0), "path must be normalized");
const positionSchema = z.object({ line: z.number().int().nonnegative(), column: z.number().int().nonnegative() }).strict();
const rangeSchema = z.object({ start: positionSchema, end: positionSchema }).strict();
const optionalString = z.string().min(1).optional();

export const payloadSchemas = {
  workspace_open: z.object({ rootName: z.string(), canonicalRoot: z.string() }).strict(),
  file_open: z.object({ path: pathSchema, preview: z.boolean() }).strict(),
  file_close: z.object({ path: pathSchema }).strict(),
  tab_focus: z.object({ path: pathSchema }).strict(),
  cursor_move: z.object({ path: pathSchema, position: positionSchema }).strict(),
  selection_change: z.object({ path: pathSchema, selections: z.array(rangeSchema), primary: z.number().int().nonnegative() }).strict(),
  scroll: z.object({ path: pathSchema, scrollTop: z.number().nonnegative(), scrollLeft: z.number().nonnegative() }).strict(),
  edit_insert: z.object({ path: pathSchema, position: positionSchema, text: z.string().min(1) }).strict(),
  edit_delete: z.object({ path: pathSchema, range: rangeSchema, deletedText: z.string().min(1) }).strict(),
  edit_replace: z.object({ path: pathSchema, range: rangeSchema, deletedText: z.string().min(1), insertedText: z.string().min(1) }).strict(),
  file_create: z.object({ path: pathSchema }).strict(),
  file_save: z.object({ path: pathSchema, contentHash: z.string().min(1) }).strict(),
  file_delete: z.object({ path: pathSchema }).strict(),
  file_rename: z.object({ from: pathSchema, to: pathSchema }).strict(),
  terminal_command: z.object({ commandId: z.string().min(1), command: z.string(), cwd: z.union([pathSchema, z.literal(".")]), shell: z.string().min(1) }).strict(),
  terminal_output: z.object({ commandId: z.string().min(1), stream: z.enum(["stdout", "stderr"]), chunk: z.string(), eof: z.boolean(), exitCode: z.number().int().optional(), signal: optionalString }).strict(),
  agent_thought: z.object({ text: z.string(), visibility: z.enum(["summary", "hidden"]) }).strict(),
  agent_tool_call: z.object({ callId: z.string().min(1), server: optionalString, tool: z.string().min(1), arguments: z.unknown() }).strict(),
  agent_tool_result: z.object({ callId: z.string().min(1), ok: z.boolean(), content: z.unknown(), errorCode: optionalString }).strict(),
  step_begin: z.object({ stepId: z.string().min(1), label: z.string().min(1).max(100), primaryPath: pathSchema.optional() }).strict(),
  step_end: z.object({ stepId: z.string().min(1), outcome: z.enum(["succeeded", "failed", "cancelled", "denied"]), summary: optionalString }).strict(),
  checkpoint: z.object({ reason: z.enum(["cadence", "final"]), files: z.array(z.object({ path: pathSchema, content: z.string().nullable(), contentHash: z.string().nullable() }).strict()) }).strict(),
  diff_marker: z.object({ path: pathSchema, range: rangeSchema, kind: z.enum(["added", "modified", "deleted"]), hunkId: z.string().min(1) }).strict(),
  error: z.object({ code: z.string().min(1), message: z.string(), recoverable: z.boolean(), source: z.enum(["ses", "playback", "agent", "provider", "mcp", "workspace", "terminal"]), details: z.unknown().optional() }).strict()
};

const eventSchemas = [
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("workspace_open"), payload: payloadSchemas.workspace_open }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("file_open"), payload: payloadSchemas.file_open }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("file_close"), payload: payloadSchemas.file_close }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("tab_focus"), payload: payloadSchemas.tab_focus }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("cursor_move"), payload: payloadSchemas.cursor_move }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("selection_change"), payload: payloadSchemas.selection_change }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("scroll"), payload: payloadSchemas.scroll }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("edit_insert"), payload: payloadSchemas.edit_insert }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("edit_delete"), payload: payloadSchemas.edit_delete }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("edit_replace"), payload: payloadSchemas.edit_replace }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("file_create"), payload: payloadSchemas.file_create }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("file_save"), payload: payloadSchemas.file_save }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("file_delete"), payload: payloadSchemas.file_delete }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("file_rename"), payload: payloadSchemas.file_rename }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("terminal_command"), payload: payloadSchemas.terminal_command }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("terminal_output"), payload: payloadSchemas.terminal_output }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("agent_thought"), payload: payloadSchemas.agent_thought }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("agent_tool_call"), payload: payloadSchemas.agent_tool_call }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("agent_tool_result"), payload: payloadSchemas.agent_tool_result }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("step_begin"), payload: payloadSchemas.step_begin }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("step_end"), payload: payloadSchemas.step_end }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("checkpoint"), payload: payloadSchemas.checkpoint }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("diff_marker"), payload: payloadSchemas.diff_marker }).strict(),
  z.object({ seq: z.number().int().nonnegative(), t: z.number().int().nonnegative(), type: z.literal("error"), payload: payloadSchemas.error }).strict()
] as const;

export const sesEventSchema = z.discriminatedUnion("type", eventSchemas);

export function validateSesEvent(value: unknown): AnySesEvent {
  return sesEventSchema.parse(value) as AnySesEvent;
}

export function isCheckpoint(event: AnySesEvent): event is SesEvent<"checkpoint"> {
  return event.type === "checkpoint";
}

export function isEditEvent(event: AnySesEvent): event is SesEvent<"edit_insert" | "edit_delete" | "edit_replace"> {
  return event.type === "edit_insert" || event.type === "edit_delete" || event.type === "edit_replace";
}
