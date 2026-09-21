import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AnthropicAdapter, GeminiAdapter, OpenAIAdapter, OpenAICompatibleAdapter, type ProviderAdapter, type ProviderId } from "@theaihatch/providers";
import { KeytarKeychain, type Keychain } from "../secrets/keychain.js";
import { RunCoordinator, type RunStatus } from "../agent/run-coordinator.js";
import type { StoredReviewDecisionInput } from "@theaihatch/storage";
import type { WorkspaceRegistry } from "./workspaces.js";

const runBody = z.object({ workspaceId: z.string().uuid(), prompt: z.string().min(1), provider: z.enum(["openai", "anthropic", "gemini", "openai-compatible"]), model: z.string().min(1), baseURL: z.string().url().optional() }).strict();
const asyncRunBody = runBody.extend({ reviewMode: z.boolean().default(false), dryRun: z.boolean().default(false) }).strict();
const runParams = z.object({ runId: z.string().uuid() }).strict();
const runQuery = z.object({ fromSeq: z.coerce.number().int().nonnegative().optional(), includeEvents: z.coerce.boolean().optional() }).strict();
const reviewBody = z.object({ decisions: z.array(z.object({ hunkId: z.string().min(1), decision: z.enum(["accepted", "rejected"]), actor: z.string().min(1).default("user"), feedback: z.string().optional() }).strict()).min(1) }).strict();
const commandApprovalBody = z.object({ approved: z.boolean(), command: z.string().min(1), cwd: z.string().min(1) }).strict();
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

function agentErrorStatus(error: unknown, fallback: number): number {
  if (error instanceof z.ZodError) return 400;
  const message = error instanceof Error ? error.message : String(error);
  if (/run not found/u.test(message)) return 404;
  if (/approval (?:is )?not pending|must include exactly one decision|does not match pending/u.test(message)) return 409;
  return fallback;
}

function sendAgentError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, statusCode: number, error: unknown): unknown {
  return reply.code(statusCode).send({ error: error instanceof Error ? error.message : String(error) });
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

  app.post("/api/agent/runs", async (request, reply) => {
    try {
      const body = asyncRunBody.parse(request.body);
      const record = registry.get(body.workspaceId);
      const run = await coordinator.start({
        tree: record.tree,
        prompt: body.prompt,
        model: body.model,
        reviewMode: body.reviewMode,
        dryRun: body.dryRun,
        writer: record.stream,
        createProvider: async () => {
          const secret = (await keychain.get(`provider:${body.provider}`)) ?? undefined;
          return adapter(body.provider, secret, body.model, body.baseURL);
        }
      });
      return reply.code(202).send(run);
    } catch (error) {
      return sendAgentError(reply, agentErrorStatus(error, 400), error);
    }
  });

  app.get<{ Params: { runId: string }; Querystring: { fromSeq?: string; includeEvents?: string } }>("/api/agent/runs/:runId", async (request, reply) => {
    try {
      const params = runParams.parse(request.params);
      const query = runQuery.parse(request.query);
      return coordinator.get(params.runId, { ...(query.fromSeq === undefined ? {} : { fromSeq: query.fromSeq }), ...(query.includeEvents === undefined ? {} : { includeEvents: query.includeEvents }) });
    } catch (error) {
      return sendAgentError(reply, agentErrorStatus(error, 404), error);
    }
  });

  app.post<{ Params: { runId: string } }>("/api/agent/runs/:runId/review", async (request, reply) => {
    try {
      const params = runParams.parse(request.params);
      const body = reviewBody.parse(request.body);
      const decisions: StoredReviewDecisionInput[] = body.decisions.map((decision) => ({ hunkId: decision.hunkId, decision: decision.decision, actor: decision.actor, ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }) }));
      return await coordinator.resolveReview(params.runId, decisions);
    } catch (error) {
      return sendAgentError(reply, agentErrorStatus(error, 400), error);
    }
  });

  app.post<{ Params: { runId: string } }>("/api/agent/runs/:runId/command-approval", async (request, reply) => {
    try {
      const params = runParams.parse(request.params);
      const body = commandApprovalBody.parse(request.body);
      return await coordinator.resolveCommand(params.runId, body);
    } catch (error) {
      return sendAgentError(reply, agentErrorStatus(error, 400), error);
    }
  });

  app.post<{ Params: { runId: string } }>("/api/agent/runs/:runId/cancel", async (request, reply) => {
    try {
      const params = runParams.parse(request.params);
      coordinator.cancel(params.runId);
      return reply.code(202).send(coordinator.get(params.runId));
    } catch (error) {
      return sendAgentError(reply, agentErrorStatus(error, 404), error);
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
        writer: record.stream,
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
