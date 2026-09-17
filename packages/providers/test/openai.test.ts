import { describe, expect, it } from "vitest";
import { normalizeProviderError } from "../src/errors.js";
import { normalizeUsage, toOpenAIMessage } from "../src/openai.js";

describe("OpenAI provider contract", () => {
  it("REQ-PRV-001 and REQ-PRV-003: maps normalized messages and usage", () => {
    const message = toOpenAIMessage({ role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read", arguments: { path: "a.ts" } }] });
    expect(message).toMatchObject({ role: "assistant", tool_calls: [{ id: "call-1", function: { name: "read", arguments: '{"path":"a.ts"}' } }] });
    expect(normalizeUsage({ prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 2 } })).toEqual({ inputTokens: 4, outputTokens: 3, cachedTokens: 1, reasoningTokens: 2 });
  });

  it("REQ-PRV-001: classifies retryable and authentication failures", () => {
    expect(normalizeProviderError({ status: 429, message: "slow down" })).toMatchObject({ kind: "rate_limit", retryable: true, status: 429 });
    expect(normalizeProviderError({ status: 401, message: "bad key" })).toMatchObject({ kind: "authentication", retryable: false, status: 401 });
  });
});
