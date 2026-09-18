import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "@theaihatch/providers";
import type { ProposedAction } from "@theaihatch/safety";
import type { WorkspaceTree } from "@theaihatch/workspace";
import type { RunCoordinator, RunStatusView } from "../src/agent/run-coordinator.js";
import { MemoryKeychain } from "../src/secrets/keychain.js";
import { registerAgentRoutes } from "../src/routes/agent.js";
import type { WorkspaceRegistry } from "../src/routes/workspaces.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const checkpointId = "checkpoint-1";
const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
const proposals: ProposedAction[] = [];

function statusView(): RunStatusView {
  return { runId, checkpointId, status: "running", events: [], pending: null, proposals, usage, error: null };
}

function fixture(): { coordinator: RunCoordinator; registry: WorkspaceRegistry; tree: WorkspaceTree; view: RunStatusView } {
  const tree = {} as WorkspaceTree;
  const view = statusView();
  const coordinator = {
    start: vi.fn().mockResolvedValue({ runId, checkpointId }),
    get: vi.fn().mockReturnValue(view),
    resolveReview: vi.fn().mockResolvedValue(view),
    resolveCommand: vi.fn().mockResolvedValue(view),
    cancel: vi.fn()
  } as unknown as RunCoordinator;
  const registry = { get: vi.fn().mockReturnValue({ tree }) } as unknown as WorkspaceRegistry;
  return { coordinator, registry, tree, view };
}

describe("agent run HTTP routes", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("REQ-REV-001 and REQ-REV-005: starts an async run and exposes every safe decision boundary", async () => {
    const { coordinator, registry, tree, view } = fixture();
    const app = Fastify();
    registerAgentRoutes(app, registry, new MemoryKeychain(), coordinator);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/runs",
      payload: { workspaceId, prompt: "make a safe change", provider: "openai", model: "fake", reviewMode: true, dryRun: true }
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ runId, checkpointId });
    expect(coordinator.start).toHaveBeenCalledWith(expect.objectContaining({ tree, prompt: "make a safe change", model: "fake", reviewMode: true, dryRun: true }));

    const state = await app.inject({ method: "GET", url: `/api/agent/runs/${runId}` });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ runId, checkpointId, status: view.status, pending: null, proposals: [] });

    const review = await app.inject({
      method: "POST",
      url: `/api/agent/runs/${runId}/review`,
      payload: { decisions: [{ hunkId: "hunk-1", decision: "accepted", actor: "user" }] }
    });
    expect(review.statusCode).toBe(200);
    expect(coordinator.resolveReview).toHaveBeenCalledWith(runId, [{ hunkId: "hunk-1", decision: "accepted", actor: "user" }]);

    const command = await app.inject({
      method: "POST",
      url: `/api/agent/runs/${runId}/command-approval`,
      payload: { approved: false, command: "rm file.txt", cwd: "." }
    });
    expect(command.statusCode).toBe(200);
    expect(coordinator.resolveCommand).toHaveBeenCalledWith(runId, { approved: false, command: "rm file.txt", cwd: "." });

    const cancelled = await app.inject({ method: "POST", url: `/api/agent/runs/${runId}/cancel` });
    expect(cancelled.statusCode).toBe(202);
    expect(coordinator.cancel).toHaveBeenCalledWith(runId);
    await app.close();
  });

  it("returns validation, missing-run, and stale-approval errors without hiding their HTTP meaning", async () => {
    const { coordinator, registry } = fixture();
    vi.spyOn(coordinator, "get").mockImplementation(() => { throw new Error(`run not found: ${runId}`); });
    vi.spyOn(coordinator, "resolveReview").mockRejectedValue(new Error(`review must include exactly one decision per hunk: ${runId}`));
    const app = Fastify();
    registerAgentRoutes(app, registry, new MemoryKeychain(), coordinator);

    const invalid = await app.inject({ method: "POST", url: "/api/agent/runs", payload: { workspaceId, prompt: "prompt", provider: "openai", model: "fake", unexpected: true } });
    expect(invalid.statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: `/api/agent/runs/${runId}` });
    expect(missing.statusCode).toBe(404);
    const stale = await app.inject({ method: "POST", url: `/api/agent/runs/${runId}/review`, payload: { decisions: [{ hunkId: "hunk-1", decision: "accepted", actor: "user" }] } });
    expect(stale.statusCode).toBe(409);
    await app.close();
  });
});
