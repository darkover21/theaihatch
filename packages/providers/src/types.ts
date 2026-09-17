export type ProviderId = "openai" | "anthropic" | "openai-compatible";

export interface ProviderModel {
  id: string;
  displayName: string;
  ownedBy?: string;
}

export interface ProviderToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

export interface ProviderToolCallMessage {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ProviderToolCallMessage[];
}

export interface ProviderRequest {
  model: string;
  messages: readonly ProviderMessage[];
  tools: readonly ProviderToolDefinition[];
  signal?: AbortSignal;
  temperature?: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

export type CompletionReason = "stop" | "tool_calls" | "length" | "blocked" | "unknown";

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool_call"; call: ProviderToolCallMessage }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "completed"; reason: CompletionReason };

export interface ConnectionTestResult {
  reachable: boolean;
  authenticated: boolean;
  modelAvailable: boolean;
  message: string;
}

export type ProviderErrorKind = "authentication" | "rate_limit" | "transient" | "invalid_request" | "unavailable" | "cancelled" | "unknown";

export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(readonly kind: ProviderErrorKind, message: string, retryable = false, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
  testConnection(model?: string, signal?: AbortSignal): Promise<ConnectionTestResult>;
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}
