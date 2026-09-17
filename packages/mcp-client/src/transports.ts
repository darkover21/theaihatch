import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, ListPromptsResult, ListResourcesResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

export interface McpRequestOptions { signal?: AbortSignal; timeoutMs?: number; }
export interface McpTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(options?: McpRequestOptions): Promise<ListToolsResult>;
  listResources(options?: McpRequestOptions): Promise<ListResourcesResult>;
  listPrompts(options?: McpRequestOptions): Promise<ListPromptsResult>;
  callTool(name: string, argumentsValue: Record<string, unknown>, options?: McpRequestOptions): Promise<CallToolResult>;
}

const requestOptions = (options?: McpRequestOptions) => options === undefined ? undefined : { ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }) };

export class SdkMcpTransport implements McpTransport {
  constructor(private readonly client: Client, private readonly transport: Transport) {}
  connect(): Promise<void> { return this.client.connect(this.transport); }
  close(): Promise<void> { return this.client.close(); }
  listTools(options?: McpRequestOptions): Promise<ListToolsResult> { return this.client.listTools(undefined, requestOptions(options)); }
  listResources(options?: McpRequestOptions): Promise<ListResourcesResult> { return this.client.listResources(undefined, requestOptions(options)); }
  listPrompts(options?: McpRequestOptions): Promise<ListPromptsResult> { return this.client.listPrompts(undefined, requestOptions(options)); }
  callTool(name: string, argumentsValue: Record<string, unknown>, options?: McpRequestOptions): Promise<CallToolResult> { return this.client.callTool({ name, arguments: argumentsValue }, undefined, requestOptions(options)) as Promise<CallToolResult>; }
}

export interface StdioTransportConfig { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; }
export interface HttpTransportConfig { url: string; headers?: Record<string, string>; }

export function createMcpTransport(serverName: string, config: StdioTransportConfig | HttpTransportConfig): McpTransport {
  const client = new Client({ name: "theaihatch", version: "0.1.0" });
  if ("command" in config) return new SdkMcpTransport(client, new StdioClientTransport({ command: config.command, ...(config.args === undefined ? {} : { args: config.args }), ...(config.cwd === undefined ? {} : { cwd: config.cwd }), ...(config.env === undefined ? {} : { env: config.env }) }));
  return new SdkMcpTransport(client, new StreamableHTTPClientTransport(new URL(config.url), { ...(config.headers === undefined ? {} : { requestInit: { headers: config.headers } }) }) as unknown as Transport);
}
