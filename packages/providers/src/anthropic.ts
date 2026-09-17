import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsBase, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { normalizeProviderError } from "./errors.js";
import type { ConnectionTestResult, ProviderAdapter, ProviderMessage, ProviderModel, ProviderRequest, ProviderStreamEvent, ProviderToolDefinition, ProviderToolCallMessage, ProviderUsage } from "./types.js";

export interface AnthropicAdapterConfig { apiKey?: string; baseURL?: string; defaultHeaders?: Record<string, string>; }

const toTool = (tool: ProviderToolDefinition): Anthropic.Tool => ({ name: tool.name, input_schema: { ...tool.inputSchema, type: "object" }, ...(tool.description === undefined ? {} : { description: tool.description }) });

function toMessages(messages: readonly ProviderMessage[]): { system?: string; messages: Anthropic.MessageParam[] } {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const result: Anthropic.MessageParam[] = [];
  for (const message of messages.filter((candidate) => candidate.role !== "system")) {
    if (message.role === "tool") { result.push({ role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId ?? "unknown", content: message.content }] }); continue; }
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      result.push({ role: "assistant", content: [...(message.content === "" ? [] : [{ type: "text" as const, text: message.content }]), ...message.toolCalls.map((call) => ({ type: "tool_use" as const, id: call.id, name: call.name, input: call.arguments }))] });
      continue;
    }
    result.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
  }
  return system === "" ? { messages: result } : { system, messages: result };
}

function usage(value: Anthropic.Usage | undefined): ProviderUsage | null { return value === undefined ? null : { inputTokens: value.input_tokens, outputTokens: value.output_tokens, cachedTokens: value.cache_read_input_tokens ?? 0, reasoningTokens: 0 }; }

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic" as const;
  private readonly client: Anthropic;
  private readonly configuredModel: string | undefined;
  constructor(config: AnthropicAdapterConfig = {}, configuredModel?: string) {
    this.configuredModel = configuredModel;
    this.client = new Anthropic({ apiKey: config.apiKey ?? "not-configured", ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }), ...(config.defaultHeaders === undefined ? {} : { defaultHeaders: config.defaultHeaders }) });
  }
  async listModels(_signal?: AbortSignal): Promise<ProviderModel[]> {
    try { const response = await this.client.models.list(); const models: ProviderModel[] = []; for await (const model of response) models.push({ id: model.id, displayName: model.display_name }); return models; }
    catch (error) { throw normalizeProviderError(error); }
  }
  async testConnection(model = this.configuredModel, signal?: AbortSignal): Promise<ConnectionTestResult> {
    if (model === undefined) return { reachable: true, authenticated: true, modelAvailable: false, message: "provider reachable; configure a model" };
    try { const result = await this.client.messages.create({ model, max_tokens: 1, messages: [{ role: "user", content: "connection test" }] }, { signal }); return { reachable: true, authenticated: true, modelAvailable: result.model === model, message: "provider and model available" }; }
    catch (error) { const normalized = normalizeProviderError(error); return { reachable: normalized.kind !== "unavailable", authenticated: normalized.kind !== "authentication", modelAvailable: false, message: normalized.message }; }
  }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    try {
      const mapped = toMessages(request.messages);
      const params: MessageCreateParamsBase = { model: request.model, max_tokens: 4096, messages: mapped.messages, ...(mapped.system === undefined ? {} : { system: mapped.system }), tools: request.tools.map(toTool), stream: true };
      const stream = await this.client.messages.create(params, { signal: request.signal });
      const calls = new Map<string, { id: string; name: string; input: string }>();
      let reason: ProviderStreamEvent & { type: "completed" } = { type: "completed", reason: "unknown" };
      for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") yield { type: "text_delta", text: event.delta.text };
          if (event.delta.type === "thinking_delta") yield { type: "thought_delta", text: event.delta.thinking };
          if (event.delta.type === "input_json_delta") { const current = calls.get(String(event.index)) ?? { id: `tool-${event.index}`, name: "", input: "" }; calls.set(String(event.index), { ...current, input: current.input + event.delta.partial_json }); }
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") calls.set(String(event.index), { id: event.content_block.id, name: event.content_block.name, input: JSON.stringify(event.content_block.input) });
        else if (event.type === "message_delta") { const currentUsage = usage(event.usage as Anthropic.Usage | undefined); if (currentUsage !== null) yield { type: "usage", usage: currentUsage }; reason = { type: "completed", reason: event.delta.stop_reason === "tool_use" ? "tool_calls" : event.delta.stop_reason === "max_tokens" ? "length" : event.delta.stop_reason === "end_turn" ? "stop" : "unknown" }; }
        else if (event.type === "message_start") { const currentUsage = usage(event.message.usage); if (currentUsage !== null) yield { type: "usage", usage: currentUsage }; }
      }
      for (const call of calls.values()) { let argumentsValue: unknown; try { argumentsValue = JSON.parse(call.input || "{}"); } catch { throw new Error(`invalid JSON arguments for tool ${call.name}`); } const normalized: ProviderToolCallMessage = { id: call.id, name: call.name, arguments: argumentsValue }; yield { type: "tool_call", call: normalized }; }
      yield reason;
    } catch (error) { throw normalizeProviderError(error); }
  }
}

export { toMessages };
