import { randomBytes } from "node:crypto";
import { z } from "zod";
import { parsePlatformTool, publicToolSchemas, type PlatformToolHandlers } from "./tools.js";

export interface MutationLease { owner: string | null; acquire(owner: string): boolean; release(owner: string): void; }
export class ControlLease implements MutationLease {
  owner: string | null = null;
  acquire(owner: string): boolean { if (this.owner !== null && this.owner !== owner) return false; this.owner = owner; return true; }
  release(owner: string): void { if (this.owner === owner) this.owner = null; }
}
export interface McpServerConfig { token?: string; handlers: PlatformToolHandlers; lease?: MutationLease; }
export const jsonRpcRequest = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), method: z.string(), params: z.record(z.unknown()).optional() });
export const jsonRpcNotification = z.object({ jsonrpc: z.literal("2.0"), id: z.undefined().optional(), method: z.string(), params: z.record(z.unknown()).optional() });
export type JsonRpcRequest = z.infer<typeof jsonRpcRequest>;
export type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };
/** A well-formed notification carries no id, so JSON-RPC forbids answering it with a response body. */
export type AcceptedNotification = { accepted: true };
export type McpOutcome = JsonRpcResponse | AcceptedNotification;

export const invalidTokenCode = -32001;
export function isAcceptedNotification(outcome: McpOutcome): outcome is AcceptedNotification { return "accepted" in outcome; }
export function isUnauthorized(outcome: McpOutcome): boolean { return !isAcceptedNotification(outcome) && outcome.error?.code === invalidTokenCode; }

export function createMcpToken(): string { return randomBytes(32).toString("hex"); }

export class McpController {
  private readonly token: string;
  private readonly lease: MutationLease;
  constructor(private readonly config: McpServerConfig) { this.token = config.token ?? createMcpToken(); this.lease = config.lease ?? new ControlLease(); }
  getToken(): string { return this.token; }
  private authorized(authorization: string | undefined): boolean { return authorization === `Bearer ${this.token}`; }
  private invalidToken(id: string | number | null): JsonRpcResponse { return { jsonrpc: "2.0", id, error: { code: invalidTokenCode, message: "invalid MCP token" } }; }
  async handle(requestValue: unknown, authorization: string | undefined, clientId: string): Promise<McpOutcome> {
    const request = jsonRpcRequest.safeParse(requestValue);
    if (!request.success) {
      const notification = jsonRpcNotification.safeParse(requestValue);
      if (!notification.success) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
      return this.authorized(authorization) ? { accepted: true } : this.invalidToken(null);
    }
    if (!this.authorized(authorization)) return this.invalidToken(request.data.id);
    if (request.data.method === "initialize") return { jsonrpc: "2.0", id: request.data.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "theaihatch", version: "0.1.0" } } };
    if (request.data.method === "tools/list") return { jsonrpc: "2.0", id: request.data.id, result: { tools: publicToolSchemas() } };
    if (request.data.method !== "tools/call") return { jsonrpc: "2.0", id: request.data.id, error: { code: -32601, message: "method not found" } };
    const params = request.data.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const parsed = parsePlatformTool(name, params.arguments);
    if ("error" in parsed) return { jsonrpc: "2.0", id: request.data.id, error: { code: -32602, message: parsed.error } };
    if (!this.lease.acquire(clientId)) return { jsonrpc: "2.0", id: request.data.id, error: { code: -32002, message: "workspace mutation control is busy" } };
    try {
      const result = parsed.name === "open_file" ? await this.config.handlers.open_file({ path: String(parsed.arguments.path) }) : parsed.name === "edit_file" ? await this.config.handlers.edit_file({ path: String(parsed.arguments.path), content: String(parsed.arguments.content) }) : parsed.name === "save_file" ? await this.config.handlers.save_file({ path: String(parsed.arguments.path) }) : parsed.name === "run_command" ? await this.config.handlers.run_command({ command: String(parsed.arguments.command), ...(typeof parsed.arguments.cwd === "string" ? { cwd: parsed.arguments.cwd } : {}) }) : await this.config.handlers.animate_step({ label: String(parsed.arguments.label) });
      return { jsonrpc: "2.0", id: request.data.id, result: { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] } };
    }
    catch (error) { return { jsonrpc: "2.0", id: request.data.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }; }
    finally { this.lease.release(clientId); }
  }
}
