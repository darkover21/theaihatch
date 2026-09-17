import { OpenAIAdapter, type OpenAIAdapterConfig } from "./openai.js";
import type { ProviderAdapter, ProviderModel, ProviderRequest, ProviderStreamEvent, ConnectionTestResult } from "./types.js";

export interface OpenAICompatibleAdapterConfig extends OpenAIAdapterConfig { baseURL: string; }
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id = "openai-compatible" as const;
  private readonly delegate: OpenAIAdapter;
  constructor(config: OpenAICompatibleAdapterConfig, configuredModel?: string) { this.delegate = new OpenAIAdapter(config, configuredModel); }
  listModels(signal?: AbortSignal): Promise<ProviderModel[]> { return this.delegate.listModels(signal); }
  testConnection(model?: string, signal?: AbortSignal): Promise<ConnectionTestResult> { return this.delegate.testConnection(model, signal); }
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> { return this.delegate.stream(request); }
}
