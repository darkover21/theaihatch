import { randomUUID } from "node:crypto";
import type { AnySesEvent, SesEventInput } from "@theaihatch/ses";
import { ProviderError, type ProviderAdapter, type ProviderMessage, type ProviderStreamEvent, type ProviderToolCallMessage, type ProviderToolDefinition, type ProviderUsage } from "@theaihatch/providers";
import { estimateCost } from "./cost.js";
import type { ReviewGate } from "./review-gate.js";

export interface AgentToolResult {
  ok: boolean;
  content: unknown;
  errorCode?: string;
}

export interface AgentTool {
  name: string;
  execute(argumentsValue: unknown, signal: AbortSignal): Promise<AgentToolResult>;
}

export interface AgentRuntimeConfig {
  model: string;
  systemPrompt: string;
  tools: readonly ProviderToolDefinition[];
  maxTurns?: number;
  maxToolCalls?: number;
  tokenBudget?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  reviewGate?: ReviewGate;
}

export interface AgentRuntimeInput {
  prompt: string;
  signal?: AbortSignal;
  executeTool: (call: ProviderToolCallMessage, signal: AbortSignal) => Promise<AgentToolResult>;
  appendSes?: (event: SesEventInput) => Promise<AnySesEvent[]>;
}

export interface AgentRunResult {
  status: "completed" | "cancelled" | "failed" | "limit_reached";
  messages: ProviderMessage[];
  usage: ProviderUsage;
  costUsd: number | null;
  priceVersion: string;
  turns: number;
  toolCalls: number;
  error: string | null;
}

const zeroUsage = (): ProviderUsage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 });
const addUsage = (left: ProviderUsage, right: ProviderUsage): ProviderUsage => ({ inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens, cachedTokens: left.cachedTokens + right.cachedTokens, reasoningTokens: left.reasoningTokens + right.reasoningTokens });
const stringifyToolContent = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value);

export class AgentRuntime {
  constructor(private readonly provider: ProviderAdapter, private readonly config: AgentRuntimeConfig) {}

  async run(input: AgentRuntimeInput): Promise<AgentRunResult> {
    const messages: ProviderMessage[] = [{ role: "system", content: this.config.systemPrompt }, { role: "user", content: input.prompt }];
    let usage = zeroUsage();
    let turns = 0;
    let toolCalls = 0;
    let status: AgentRunResult["status"] = "completed";
    let error: string | null = null;
    const maxTurns = this.config.maxTurns ?? 20;
    const maxToolCalls = this.config.maxToolCalls ?? 100;
    const maxRetries = this.config.maxRetries ?? 2;
    const sleep = this.config.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const random = this.config.random ?? Math.random;

    const stepId = `run-${randomUUID()}`;
    await input.appendSes?.({ type: "step_begin", payload: { stepId, label: "Agent run" } });
    try {
      while (turns < maxTurns) {
        if (input.signal?.aborted === true) throw new ProviderError("cancelled", "run cancelled");
        if (this.config.tokenBudget !== undefined && usage.inputTokens + usage.outputTokens >= this.config.tokenBudget) { status = "limit_reached"; await input.appendSes?.({ type: "error", payload: { code: "limit_reached", message: "token budget reached", recoverable: false, source: "agent" } }); break; }
        turns += 1;
        let attempt = 0;
        const events: ProviderStreamEvent[] = [];
        while (true) {
          try {
            for await (const event of this.provider.stream({ model: this.config.model, messages, tools: this.config.tools, ...(input.signal === undefined ? {} : { signal: input.signal }) })) {
              events.push(event);
              if (event.type === "text_delta" || event.type === "thought_delta") await input.appendSes?.({ type: "agent_thought", payload: { text: event.text, visibility: event.type === "thought_delta" ? "summary" : "hidden" } });
              if (event.type === "usage") usage = addUsage(usage, event.usage);
              if (event.type === "tool_call") await input.appendSes?.({ type: "agent_tool_call", payload: { callId: event.call.id, tool: event.call.name, arguments: event.call.arguments } });
            }
            break;
          } catch (caught) {
            const providerError = caught instanceof ProviderError ? caught : new ProviderError("unknown", caught instanceof Error ? caught.message : String(caught));
            if (!providerError.retryable || attempt >= maxRetries) throw providerError;
            const delay = (this.config.baseBackoffMs ?? 100) * (2 ** attempt) + Math.floor(random() * (this.config.baseBackoffMs ?? 100));
            await input.appendSes?.({ type: "error", payload: { code: "provider_retry", message: `retrying after ${delay}ms`, recoverable: true, source: "provider" } });
            await sleep(delay);
            attempt += 1;
          }
        }
        const text = events.filter((event): event is Extract<ProviderStreamEvent, { type: "text_delta" }> => event.type === "text_delta").map((event) => event.text).join("");
        const calls = events.filter((event): event is Extract<ProviderStreamEvent, { type: "tool_call" }> => event.type === "tool_call").map((event) => event.call);
        const completion = events.find((event): event is Extract<ProviderStreamEvent, { type: "completed" }> => event.type === "completed");
        messages.push({ role: "assistant", content: text, ...(calls.length === 0 ? {} : { toolCalls: calls }) });
        if (calls.length === 0 || completion?.reason === "stop" || completion?.reason === "blocked") break;
        if (toolCalls + calls.length > maxToolCalls) { status = "limit_reached"; await input.appendSes?.({ type: "error", payload: { code: "limit_reached", message: "tool call limit reached", recoverable: false, source: "agent" } }); break; }
        for (const call of calls) {
          toolCalls += 1;
          const result = await input.executeTool(call, input.signal ?? new AbortController().signal);
          await input.appendSes?.({ type: "agent_tool_result", payload: { callId: call.id, ok: result.ok, content: result.content, ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }) } });
          messages.push({ role: "tool", content: stringifyToolContent(result.content), toolCallId: call.id });
        }
        if (this.config.reviewGate !== undefined) { if (this.config.reviewGate.isBlocked()) await this.config.reviewGate.wait(input.signal); const feedback = this.config.reviewGate.consumeFeedback(); if (feedback.length > 0) messages.push({ role: "user", content: JSON.stringify({ review: feedback }) }); }
      }
      if (turns >= maxTurns && status === "completed") { status = "limit_reached"; await input.appendSes?.({ type: "error", payload: { code: "limit_reached", message: "turn limit reached", recoverable: false, source: "agent" } }); }
    } catch (caught) {
      const normalized = caught instanceof ProviderError ? caught : new ProviderError("unknown", caught instanceof Error ? caught.message : String(caught));
      status = normalized.kind === "cancelled" || input.signal?.aborted === true ? "cancelled" : "failed";
      error = normalized.message;
      await input.appendSes?.({ type: "error", payload: { code: normalized.kind, message: normalized.message, recoverable: normalized.retryable, source: "agent" } });
    }
    const price = estimateCost(this.config.model, usage);
    await input.appendSes?.({ type: "step_end", payload: { stepId, outcome: status === "completed" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed", summary: error ?? status } });
    return { status, messages, usage, costUsd: price.costUsd, priceVersion: price.priceVersion, turns, toolCalls, error };
  }
}
