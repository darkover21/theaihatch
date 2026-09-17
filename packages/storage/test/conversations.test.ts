import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffFile } from "@theaihatch/review";
import { ConversationRepository } from "../src/conversations.js";
import { ReviewRepository } from "../src/reviews.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe("conversation persistence", () => {
  it("REQ-AGT-006 and REQ-AGT-005: reloads ordered messages, run status, and exact usage", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-conversation-"));
    temporaryDirectories.push(directory);
    const repository = new ConversationRepository(path.join(directory, "sessions.sqlite"));
    repository.createConversation({ id: "conversation-1", workspacePath: ".", createdAt: "2026-01-01T00:00:00.000Z" });
    repository.appendMessage({ id: "message-1", conversationId: "conversation-1", role: "user", content: "hello", toolCallId: null, toolName: null, createdAt: "2026-01-01T00:00:01.000Z" });
    repository.appendMessage({ id: "message-2", conversationId: "conversation-1", role: "assistant", content: "cancelled", toolCallId: null, toolName: null, createdAt: "2026-01-01T00:00:02.000Z" });
    repository.createRun({ id: "run-1", conversationId: "conversation-1", status: "running", startedAt: "2026-01-01T00:00:01.000Z", endedAt: null, error: null });
    repository.updateRun("run-1", "cancelled", "2026-01-01T00:00:03.000Z", "cancelled");
    repository.saveUsage("run-1", { inputTokens: 10, outputTokens: 5, cachedTokens: 2, reasoningTokens: 1, costUsd: 0.01, priceVersion: "test-v1" });
    repository.close();
    const reloaded = new ConversationRepository(path.join(directory, "sessions.sqlite"));
    expect(reloaded.listMessages("conversation-1").map((message) => message.content)).toEqual(["hello", "cancelled"]);
    expect(reloaded.getRun("run-1").status).toBe("cancelled");
    expect(reloaded.getUsage("run-1").inputTokens).toBe(10);
    reloaded.close();
    const reviews = new ReviewRepository(directory);
    const snapshot = reviews.createSnapshot({ runId: "run-1", checkpointId: "cp-1", files: [diffFile("README.md", "before", "after")] });
    expect(reviews.listSnapshots("run-1")[0]?.id).toBe(snapshot.id);
    reviews.close();
  });
});
