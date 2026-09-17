import { GoogleGenAI, type Content, type FunctionDeclaration, type GenerateContentResponseUsageMetadata } from "@google/genai";
import { normalizeProviderError } from "./errors.js";
import type { CompletionReason, ConnectionTestResult, ProviderAdapter, ProviderMessage, ProviderModel, ProviderRequest, ProviderStreamEvent, ProviderToolDefinition, ProviderUsage } from "./types.js";

export interface GeminiAdapterConfig {
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}

const blockedReasons = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"]);

function toolResult(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toGeminiTools(tools: readonly ProviderToolDefinition[]): FunctionDeclaration[] {
  return tools.map((tool) => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parametersJsonSchema: { ...tool.inputSchema, type: "object" } }));
}

function toGeminiContents(messages: readonly ProviderMessage[]): { systemInstruction?: Content; contents: Content[] } {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const contents: Content[] = [];
  const toolNames = new Map<string, string>();
  let pendingToolParts: NonNullable<Content["parts"]> = [];
  const flushToolParts = (): void => {
    if (pendingToolParts.length > 0) {
      contents.push({ role: "user", parts: pendingToolParts });
      pendingToolParts = [];
    }
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const name = toolNames.get(message.toolCallId ?? "");
      if (name === undefined) throw new Error(`missing Gemini function name for tool result ${message.toolCallId ?? "unknown"}`);
      pendingToolParts.push({ functionResponse: { ...(message.toolCallId === undefined ? {} : { id: message.toolCallId }), name, response: { output: toolResult(message.content) } } });
      continue;
    }
    flushToolParts();
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
      const parts: NonNullable<Content["parts"]> = [...(message.content === "" ? [] : [{ text: message.content }]), ...(message.toolCalls ?? []).map((call) => ({ functionCall: { id: call.id, name: call.name, args: call.arguments as Record<string, unknown> } }))];
      contents.push({ role: "model", parts });
      continue;
    }
    contents.push({ role: "user", parts: [{ text: message.content }] });
  }
  flushToolParts();
  return system === "" ? { contents } : { systemInstruction: { parts: [{ text: system }] }, contents };
}

function normalizeGeminiUsage(value: GenerateContentResponseUsageMetadata | undefined): ProviderUsage | null {
  if (value === undefined) return null;
  return { inputTokens: value.promptTokenCount ?? 0, outputTokens: value.candidatesTokenCount ?? 0, cachedTokens: value.cachedContentTokenCount ?? 0, reasoningTokens: value.thoughtsTokenCount ?? 0 };
}

function completionReason(reason: string | undefined, blocked: boolean): CompletionReason {
  if (blocked || (reason !== undefined && blockedReasons.has(reason))) return "blocked";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "STOP") return "stop";
  return "unknown";
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  private readonly client: GoogleGenAI;
  private readonly configuredModel: string | undefined;

  constructor(config: GeminiAdapterConfig = {}, configuredModel?: string) {
    this.configuredModel = configuredModel;
    this.client = new GoogleGenAI({ apiKey: config.apiKey ?? "not-configured", ...(config.baseURL === undefined && config.defaultHeaders === undefined ? {} : { httpOptions: { ...(config.baseURL === undefined ? {} : { baseUrl: config.baseURL }), ...(config.defaultHeaders === undefined ? {} : { headers: config.defaultHeaders }) } }) });
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModel[]> {
    try {
      const pager = await this.client.models.list({ config: { ...(signal === undefined ? {} : { abortSignal: signal }) } });
      const models: ProviderModel[] = [];
      for await (const model of pager) if (model.name !== undefined) models.push({ id: model.name.replace(/^models\//u, ""), displayName: model.displayName ?? model.name });
      return models;
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async testConnection(model = this.configuredModel, signal?: AbortSignal): Promise<ConnectionTestResult> {
    if (model === undefined) return { reachable: true, authenticated: true, modelAvailable: false, message: "provider reachable; configure a model" };
    try {
      const response = await this.client.models.generateContent({ model, contents: "connection test", config: { maxOutputTokens: 1, ...(signal === undefined ? {} : { abortSignal: signal }) } });
      const blocked = response.promptFeedback?.blockReason !== undefined || response.candidates?.some((candidate) => candidate.finishReason !== undefined && blockedReasons.has(candidate.finishReason)) === true;
      return { reachable: true, authenticated: true, modelAvailable: !blocked, message: blocked ? "provider reachable; connection test was safety blocked" : "provider and model available" };
    } catch (error) {
      const normalized = normalizeProviderError(error);
      return { reachable: normalized.kind !== "unavailable", authenticated: normalized.kind !== "authentication", modelAvailable: false, message: normalized.message };
    }
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    try {
      const mapped = toGeminiContents(request.messages);
      const stream = await this.client.models.generateContentStream({ model: request.model, contents: mapped.contents, config: { ...(mapped.systemInstruction === undefined ? {} : { systemInstruction: mapped.systemInstruction }), ...(request.tools.length === 0 ? {} : { tools: [{ functionDeclarations: toGeminiTools(request.tools) }] }), ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(request.signal === undefined ? {} : { abortSignal: request.signal }) } });
      const calls = new Map<string, { id: string; name: string; arguments: unknown }>();
      let usage: ProviderUsage | null = null;
      let finishReason: string | undefined;
      let blocked = false;
      let generatedCallIndex = 0;
      for await (const chunk of stream) {
        blocked ||= chunk.promptFeedback?.blockReason !== undefined;
        const candidate = chunk.candidates?.[0];
        if (candidate !== undefined) {
          finishReason = candidate.finishReason ?? finishReason;
          for (const part of candidate.content?.parts ?? []) {
            if (part.text !== undefined && part.text !== "") yield part.thought === true ? { type: "thought_delta", text: part.text } : { type: "text_delta", text: part.text };
            if (part.functionCall !== undefined) {
              const name = part.functionCall.name;
              if (name === undefined || name === "") throw new Error("Gemini returned a function call without a name");
              const id = part.functionCall.id ?? `gemini-call-${generatedCallIndex++}`;
              calls.set(id, { id, name, arguments: part.functionCall.args ?? {} });
            }
          }
        }
        usage = normalizeGeminiUsage(chunk.usageMetadata) ?? usage;
      }
      if (usage !== null) yield { type: "usage", usage };
      for (const call of calls.values()) yield { type: "tool_call", call };
      yield { type: "completed", reason: completionReason(finishReason, blocked) };
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }
}

export { completionReason, normalizeGeminiUsage, toGeminiContents, toGeminiTools };
