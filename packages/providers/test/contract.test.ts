import { describe, expect, it } from "vitest";
import { AnthropicAdapter, OpenAIAdapter, OpenAICompatibleAdapter, toMessages } from "../src/index.js";
import type { ProviderAdapter } from "../src/types.js";

const adapters = (): ProviderAdapter[] => [new OpenAIAdapter({}, "gpt-test"), new AnthropicAdapter({}, "claude-test"), new OpenAICompatibleAdapter({ baseURL: "http://127.0.0.1:1234/v1" }, "local-test")];
describe("provider contract", () => {
  it("REQ-PRV-001 and REQ-PRV-005: all selected adapters expose the normalized surface", () => { for (const adapter of adapters()) { expect(adapter.id).toBeTypeOf("string"); expect(adapter.listModels).toBeTypeOf("function"); expect(adapter.testConnection).toBeTypeOf("function"); expect(adapter.stream).toBeTypeOf("function"); } });
  it("REQ-PRV-002: maps system, assistant tool use, and tool results for Anthropic", () => { const mapped = toMessages([{ role: "system", content: "rules" }, { role: "user", content: "change file" }, { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "edit_file", arguments: { path: "a" } }] }, { role: "tool", content: "ok", toolCallId: "call-1" }]); expect(mapped.system).toBe("rules"); expect(mapped.messages[1]?.role).toBe("assistant"); expect(mapped.messages[2]?.role).toBe("user"); });
});
