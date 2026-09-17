import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AnthropicAdapter, GeminiAdapter, OpenAIAdapter, OpenAICompatibleAdapter, type ProviderAdapter, type ProviderId } from "@theaihatch/providers";
import { KeytarKeychain, type Keychain } from "../secrets/keychain.js";
import { RunCoordinator, type RunStatus } from "../agent/run-coordinator.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const runBody = z.object({ workspaceId: z.string().uuid(), prompt: z.string().min(1), provider: z.enum(["openai", "anthropic", "gemini", "openai-compatible"]), model: z.string().min(1), baseURL: z.string().url().optional() }).strict();
const secretBody = z.object({ secret: z.string().min(1) }).strict();
const testBody = z.object({ model: z.string().min(1), baseURL: z.string().url().optional() }).strict();
const terminalStatuses = new Set<RunStatus>(["completed", "cancelled", "failed", "limit_reached"]);

function adapter(provider: ProviderId, secret: string | undefined, model: string, baseURL: string | undefined): ProviderAdapter {
  if (provider === "anthropic") return new AnthropicAdapter({ ...(secret === undefined ? {} : { apiKey: secret }), ...(baseURL === undefined ? {} : { baseURL }) }, model);
  if (provider === "gemini") return new GeminiAdapter({ ...(secret === undefined ? {} : { apiKey: secret }), ...(baseURL === undefined ? {} : { baseURL }) }, model);
  if (provider === "openai-compatible") {
    if (baseURL === undefined) throw new Error("baseURL is required for OpenAI-compatible providers");
    return new OpenAICompatibleAdapter({ ...(secret === undefined ? {} : { apiKey: secret }), baseURL }, model);
  }
  return new OpenAIAdapter({ ...(secret === undefined ? {} : { apiKey: secret }), ...(baseURL === undefined ? {} : { baseURL }) }, model);
}

async function waitForTerminal(coordinator: RunCoordinator, runId: string): Promise<ReturnType<RunCoordinator["get"]>> {
  while (true) {
    const status = coordinator.get(runId);
    if (terminalStatuses.has(status.status)) return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

export function registerAgentRoutes(app: FastifyInstance, registry: WorkspaceRegistry, keychain: Keychain = new KeytarKeychain(), coordinator = new RunCoordinator()): void {
  app.put<{ Params: { provider: string } }>("/api/providers/:provider/secret", async (request, reply) => {
    try {
      const body = secretBody.parse(request.body);
      if (!/^(openai|anthropic|gemini|openai-compatible)$/u.test(request.params.provider)) return reply.code(400).send({ error: "unknown provider" });
      await keychain.set(`provider:${request.params.provider}`, body.secret);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { provider: string } }>("/api/providers/:provider/test", async (request, reply) => {
    try {
      const body = testBody.parse(request.body);
      if (!/^(openai|anthropic|gemini|openai-compatible)$/u.test(request.params.provider)) return reply.code(400).send({ error: "unknown provider" });
      const secret = (await keychain.get(`provider:${request.params.provider}`)) ?? undefined;
      return await adapter(request.params.provider as ProviderId, secret, body.model, body.baseURL).testConnection(body.model);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/agent/run", async (request, reply) => {
    try {
      const body = runBody.parse(request.body);
      const record = registry.get(body.workspaceId);
      const run = await coordinator.start({
        tree: record.tree,
        prompt: body.prompt,
        model: body.model,
        reviewMode: false,
        dryRun: false,
        createProvider: async () => {
          const secret = (await keychain.get(`provider:${body.provider}`)) ?? undefined;
          return adapter(body.provider, secret, body.model, body.baseURL);
        }
      });
      const status = await waitForTerminal(coordinator, run.runId);
      return { runId: run.runId, checkpointId: run.checkpointId, status: status.status, usage: status.usage, events: status.events, error: status.error };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
