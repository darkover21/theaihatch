import { describe, expect, it } from "vitest";
import { GeminiAdapter } from "../src/gemini.js";

describe("Gemini provider adapter", () => {
  it("REQ-PRV-004: normalizes streamed text, function calls, usage, and safety completion", async () => {
    const adapter = new GeminiAdapter({}, "gemini-test");
    const fakeClient = {
      models: {
        generateContentStream: async () => (async function* () {
          yield { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "hello" }, { functionCall: { id: "call-1", name: "read_file", args: { path: "a.ts" } } }] }, finishReason: "SAFETY" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, cachedContentTokenCount: 1, thoughtsTokenCount: 2 } };
        })()
      }
    };
    Object.assign(adapter as unknown as { client: unknown }, { client: fakeClient });

    const events = [];
    for await (const event of adapter.stream({ model: "gemini-test", messages: [{ role: "user", content: "read a.ts" }], tools: [] })) events.push(event);

    expect(events).toEqual([
      { type: "thought_delta", text: "thinking" },
      { type: "text_delta", text: "hello" },
      { type: "usage", usage: { inputTokens: 4, outputTokens: 3, cachedTokens: 1, reasoningTokens: 2 } },
      { type: "tool_call", call: { id: "call-1", name: "read_file", arguments: { path: "a.ts" } } },
      { type: "completed", reason: "blocked" }
    ]);
  });
});
