import OpenAI from "openai";
import { normalizeProviderError } from "./errors.js";
import type { ConnectionTestResult, ProviderAdapter, ProviderMessage, ProviderModel, ProviderRequest, ProviderStreamEvent, ProviderToolDefinition, ProviderToolCallMessage, ProviderUsage } from "./types.js";

export interface OpenAIAdapterConfig {
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  organization?: string;
}

function toOpenAIMessage(message: ProviderMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId ?? "unknown" };
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls === undefined ? {} : {
        tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
      })
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAITools(tools: readonly ProviderToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({ type: "function", function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.inputSchema } }));
}

function normalizeUsage(usage: OpenAI.CompletionUsage | null | undefined): ProviderUsage | null {
  if (usage === null || usage === undefined) return null;
  const details = usage.prompt_tokens_details;
  const completionDetails = usage.completion_tokens_details;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedTokens: details?.cached_tokens ?? 0,
    reasoningTokens: completionDetails?.reasoning_tokens ?? 0
  };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  private readonly client: OpenAI;
  private readonly configuredModel: string | undefined;

  constructor(config: OpenAIAdapterConfig = {}, configuredModel?: string) {
    this.configuredModel = configuredModel;
    this.client = new OpenAI({
      apiKey: config.apiKey ?? "not-configured",
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      ...(config.defaultHeaders === undefined ? {} : { defaultHeaders: config.defaultHeaders }),
      ...(config.organization === undefined ? {} : { organization: config.organization })
    });
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    try {
      const response = await this.client.models.list({ signal });
      const models: ProviderModel[] = [];
      for await (const model of response) models.push({ id: model.id, displayName: model.id, ...(model.owned_by === undefined ? {} : { ownedBy: model.owned_by }) });
      return models;
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async testConnection(model = this.configuredModel, signal?: AbortSignal): Promise<ConnectionTestResult> {
    try {
      const models = await this.listModels(signal);
      return { reachable: true, authenticated: true, modelAvailable: model === undefined || models.some((candidate) => candidate.id === model), message: model === undefined ? "provider reachable" : models.some((candidate) => candidate.id === model) ? "provider and model available" : "provider reachable; model was not listed" };
    } catch (error) {
      const normalized = normalizeProviderError(error);
      return { reachable: normalized.kind !== "unavailable", authenticated: normalized.kind !== "authentication", modelAvailable: false, message: normalized.message };
    }
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    try {
      const stream = await this.client.chat.completions.create({
        model: request.model,
        messages: request.messages.map(toOpenAIMessage),
        tools: toOpenAITools(request.tools),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.temperature === undefined ? {} : { temperature: request.temperature })
      }, { signal: request.signal });
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      let completionReason: ProviderStreamEvent & { type: "completed" } = { type: "completed", reason: "unknown" };
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const text = choice?.delta.content;
        if (text !== null && text !== undefined && text !== "") yield { type: "text_delta", text };
        for (const delta of choice?.delta.tool_calls ?? []) {
          const current = calls.get(delta.index) ?? { id: delta.id ?? `tool-${delta.index}`, name: "", arguments: "" };
          calls.set(delta.index, { id: delta.id ?? current.id, name: delta.function?.name ?? current.name, arguments: current.arguments + (delta.function?.arguments ?? "") });
        }
        if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) completionReason = { type: "completed", reason: choice.finish_reason === "tool_calls" ? "tool_calls" : choice.finish_reason === "length" ? "length" : "stop" };
        const usage = normalizeUsage(chunk.usage);
        if (usage !== null) yield { type: "usage", usage };
      }
      for (const call of calls.values()) {
        let argumentsValue: unknown;
        try { argumentsValue = JSON.parse(call.arguments || "{}"); } catch { throw new Error(`invalid JSON arguments for tool ${call.name}`); }
        const normalized: ProviderToolCallMessage = { id: call.id, name: call.name, arguments: argumentsValue };
        yield { type: "tool_call", call: normalized };
      }
      yield completionReason;
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }
}

export { toOpenAIMessage, normalizeUsage };
