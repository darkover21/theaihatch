import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderAdapter, ProviderModel, ProviderRequest, ProviderStreamEvent } from "@theaihatch/providers";
import type { GitCheckpoint } from "@theaihatch/safety";
import { WorkspaceTree } from "@theaihatch/workspace";
import { RunCoordinator, type StartRunInput } from "../src/agent/run-coordinator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

class FakeProvider implements ProviderAdapter {
  readonly id = "openai" as const;
  calls = 0;

  constructor(private readonly requestReview = false) {}

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: "fake", displayName: "fake" }];
  }

  async testConnection(): Promise<{ reachable: boolean; authenticated: boolean; modelAvailable: boolean; message: string }> {
    return { reachable: true, authenticated: true, modelAvailable: true, message: "ok" };
  }

  async *stream(_request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.calls += 1;
    if (this.requestReview && this.calls === 1) {
      yield { type: "tool_call", call: { id: "edit-1", name: "edit_file", arguments: { path: "a.ts", content: "after" } } };
      yield { type: "completed", reason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "usage", usage: { inputTokens: 3, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0 } };
    yield { type: "completed", reason: "stop" };
  }
}

class FakeCheckpointStore {
  readonly calls: Array<{ root: string; label: string }> = [];

  async create(root: string, label: string): Promise<GitCheckpoint> {
    this.calls.push({ root, label });
    return { id: "checkpoint-1", root, gitCommit: "commit-1", indexPath: null, files: [], createdAt: "2026-09-17T00:00:00.000Z" };
  }
}

async function fixture(options: { provider?: FakeProvider; checkpointStore?: FakeCheckpointStore; reviewMode?: boolean } = {}): Promise<{ coordinator: RunCoordinator; input: StartRunInput; provider: FakeProvider; checkpointStore: FakeCheckpointStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-run-coordinator-root-"));
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-run-coordinator-data-"));
  temporaryDirectories.push(root, dataDirectory);
  await fs.writeFile(path.join(root, "a.ts"), "before", "utf8");
  const provider = options.provider ?? new FakeProvider(options.reviewMode ?? false);
  const checkpointStore = options.checkpointStore ?? new FakeCheckpointStore();
  const coordinator = new RunCoordinator({ checkpointStore, dataDirectory });
  return {
    coordinator,
    provider,
    checkpointStore,
    input: {
      tree: await WorkspaceTree.open(root),
      prompt: "make a safe change",
      model: "fake",
      reviewMode: options.reviewMode ?? false,
      dryRun: false,
      createProvider: () => provider
    }
  };
}

async function waitForTerminal(coordinator: RunCoordinator, runId: string): Promise<void> {
  await vi.waitFor(() => expect(["completed", "cancelled", "failed", "limit_reached"]).toContain(coordinator.get(runId).status));
}

describe("run coordinator", () => {
  it("REQ-SAF-002: creates a checkpoint before the first provider turn", async () => {
    const { coordinator, input, provider, checkpointStore } = await fixture();

    const run = await coordinator.start(input);
    await waitForTerminal(coordinator, run.runId);

    expect(checkpointStore.calls).toEqual([expect.objectContaining({ label: "theaihatch agent run checkpoint" })]);
    expect(provider.calls).toBeGreaterThan(0);
  });

  it("REQ-SAF-002: rejects a checkpoint failure before constructing a provider", async () => {
    const { input } = await fixture();
    let providerConstructed = false;
    const failureDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-run-coordinator-failure-"));
    temporaryDirectories.push(failureDataDirectory);
    const failingCoordinator = new RunCoordinator({
      dataDirectory: failureDataDirectory,
      checkpointStore: { create: async () => { throw new Error("checkpoint unavailable"); } }
    });

    await expect(failingCoordinator.start({ ...input, createProvider: () => { providerConstructed = true; return new FakeProvider(); } })).rejects.toThrow("checkpoint unavailable");
    expect(providerConstructed).toBe(false);
  });

  it("REQ-REV-003: status stays waiting_for_review until a complete decision set arrives", async () => {
    const { coordinator, input } = await fixture({ reviewMode: true });

    const run = await coordinator.start(input);
    try {
      await vi.waitFor(() => expect(coordinator.get(run.runId).pending?.kind).toBe("review"));
      expect(coordinator.get(run.runId).status).toBe("waiting_for_review");
      expect(coordinator.get(run.runId).events.map((event) => event.type)).toContain("diff_marker");
      const pending = coordinator.get(run.runId).pending;
      if (pending?.kind !== "review") throw new Error("expected pending review");

      await expect(coordinator.resolveReview(run.runId, [])).rejects.toThrow("one decision per hunk");
      expect(coordinator.get(run.runId).status).toBe("waiting_for_review");
      await coordinator.resolveReview(run.runId, pending.hunks.map((hunk) => ({ hunkId: hunk.id, decision: "accepted", actor: "user" })));
      await waitForTerminal(coordinator, run.runId);
    } finally {
      if (!["completed", "cancelled", "failed", "limit_reached"].includes(coordinator.get(run.runId).status)) {
        coordinator.cancel(run.runId);
        await waitForTerminal(coordinator, run.runId);
      }
    }
  });

  it("returns immutable status views and cancels active work", async () => {
    const { coordinator, input } = await fixture({ reviewMode: true });

    const run = await coordinator.start(input);
    await vi.waitFor(() => expect(coordinator.get(run.runId).pending?.kind).toBe("review"));
    const first = coordinator.get(run.runId);
    first.events.length = 0;
    first.proposals.push({ kind: "command", command: "mutated", description: "mutated" });
    coordinator.cancel(run.runId);
    await waitForTerminal(coordinator, run.runId);

    expect(coordinator.get(run.runId).proposals).toEqual([]);
    expect(coordinator.get(run.runId).status).toBe("cancelled");
  });
});
