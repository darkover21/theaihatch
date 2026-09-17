import { z } from "zod";
import type { McpRequestOptions, McpTransport, HttpTransportConfig, StdioTransportConfig } from "./transports.js";
import { validateToolArguments } from "./tool-policy.js";

const stdio = z.object({ type: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()).optional(), cwd: z.string().optional(), environment: z.record(z.string()).optional(), enabled: z.boolean().default(true), startupTimeoutMs: z.number().int().positive().default(10_000) });
const http = z.object({ type: z.literal("streamable-http"), url: z.string().url(), headers: z.record(z.string()).optional(), enabled: z.boolean().default(true), startupTimeoutMs: z.number().int().positive().default(10_000) });
export const McpServerConfig = z.discriminatedUnion("type", [stdio, http]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;
export type McpPolicy = "always_ask" | "allow" | "deny";
export interface DiscoveredTool { server: string; name: string; qualifiedName: string; description?: string; inputSchema: Record<string, unknown>; policy: McpPolicy; }
export interface ServerState { name: string; status: "disconnected" | "connected" | "unavailable"; error?: string; }
export interface RegistryServer { name: string; config: McpServerConfig; transport: McpTransport; }
export interface ServerCapabilities { resources: number; prompts: number; }

const timeoutSignal = (options: McpRequestOptions | undefined, timeoutMs: number): McpRequestOptions => {
  const controller = new AbortController();
  const _timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options?.signal !== undefined) options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  return { signal: controller.signal, timeoutMs: options?.timeoutMs ?? timeoutMs };
};

export class McpRegistry {
  private readonly servers = new Map<string, RegistryServer>();
  private readonly tools = new Map<string, DiscoveredTool>();
  private readonly states = new Map<string, ServerState>();
  private readonly capabilities = new Map<string, ServerCapabilities>();
  register(name: string, input: z.input<typeof McpServerConfig>, transport: McpTransport): void { const config = McpServerConfig.parse(input); this.servers.set(name, { name, config, transport }); this.states.set(name, { name, status: "disconnected" }); this.capabilities.set(name, { resources: 0, prompts: 0 }); }
  getStates(): ServerState[] { return [...this.states.values()]; }
  listTools(): DiscoveredTool[] { return [...this.tools.values()]; }
  getCapabilities(name: string): ServerCapabilities { return this.capabilities.get(name) ?? { resources: 0, prompts: 0 }; }
  async refresh(name: string): Promise<DiscoveredTool[]> {
    const server = this.servers.get(name); if (server === undefined) throw new Error(`unknown MCP server: ${name}`);
    try {
      const options = timeoutSignal(undefined, server.config.startupTimeoutMs);
      await server.transport.connect();
      if (!server.config.enabled) return [];
      const [result, resources, prompts] = await Promise.all([server.transport.listTools(options), server.transport.listResources(options), server.transport.listPrompts(options)]);
      this.capabilities.set(name, { resources: resources.resources.length, prompts: prompts.prompts.length });
      for (const key of [...this.tools.keys()]) if (key.startsWith(`${name}/`)) this.tools.delete(key);
      const discovered = result.tools.map((tool) => ({ server: name, name: tool.name, qualifiedName: `${name}/${tool.name}`, ...(tool.description === undefined ? {} : { description: tool.description }), inputSchema: tool.inputSchema as Record<string, unknown>, policy: "always_ask" as const }));
      for (const tool of discovered) this.tools.set(tool.qualifiedName, tool);
      this.states.set(name, { name, status: "connected" });
      return discovered;
    } catch (error) { this.states.set(name, { name, status: "unavailable", error: error instanceof Error ? error.message : String(error) }); return []; }
  }
  async call(qualifiedName: string, argumentsValue: Record<string, unknown>, policy: McpPolicy, options?: McpRequestOptions): Promise<unknown> {
    const tool = this.tools.get(qualifiedName); if (tool === undefined) throw new Error(`unknown MCP tool: ${qualifiedName}`);
    if (policy === "deny") return { ok: false, code: "denied" };
    if (policy === "always_ask") return { ok: false, code: "approval_required" };
    const server = this.servers.get(tool.server); if (server === undefined) throw new Error(`unknown MCP server: ${tool.server}`);
    const validation = validateToolArguments(tool.inputSchema, argumentsValue); if (!validation.ok) return { ok: false, code: "invalid_arguments", message: validation.message };
    try { return await server.transport.callTool(tool.name, argumentsValue, timeoutSignal(options, options?.timeoutMs ?? 30_000)); }
    catch (error) { return { ok: false, code: "server_unavailable", message: error instanceof Error ? error.message : String(error) }; }
  }
  async close(): Promise<void> { await Promise.all([...this.servers.values()].map(async (server) => { try { await server.transport.close(); } catch { /* failure isolation */ } })); }
}

export const toTransportConfig = (config: McpServerConfig): StdioTransportConfig | HttpTransportConfig => config.type === "stdio" ? { command: config.command, ...(config.args === undefined ? {} : { args: config.args }), ...(config.cwd === undefined ? {} : { cwd: config.cwd }), ...(config.environment === undefined ? {} : { env: config.environment }) } : { url: config.url, ...(config.headers === undefined ? {} : { headers: config.headers }) };
