import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentRuntime, type AgentToolResult } from "@theaihatch/agent";
import { AnthropicAdapter, OpenAIAdapter, OpenAICompatibleAdapter, type ProviderAdapter, type ProviderId } from "@theaihatch/providers";
import { ConversationRepository } from "@theaihatch/storage";
import { SesReader, SesWriter } from "../ses.js";
import { createWorkspaceTools } from "../agent/ses-recorder.js";
import { GitCheckpointStore } from "@theaihatch/safety";
import { userPaths } from "@theaihatch/packaging";
import { KeytarKeychain, type Keychain } from "../secrets/keychain.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const runBody = z.object({ workspaceId: z.string().uuid(), prompt: z.string().min(1), provider: z.enum(["openai", "anthropic", "openai-compatible"]), model: z.string().min(1), baseURL: z.string().url().optional() }).strict();
const secretBody = z.object({ secret: z.string().min(1) }).strict();
const testBody = z.object({ model: z.string().min(1), baseURL: z.string().url().optional() }).strict();

function adapter(provider: ProviderId, secret: string | undefined, model: string, baseURL: string | undefined): ProviderAdapter { if (provider === "anthropic") return new AnthropicAdapter({ ...(secret === undefined ? {} : { apiKey: secret }), ...(baseURL === undefined ? {} : { baseURL }) }, model); if (provider === "openai-compatible") { if (baseURL === undefined) throw new Error("baseURL is required for OpenAI-compatible providers"); return new OpenAICompatibleAdapter({ ...(secret === undefined ? {} : { apiKey: secret }), baseURL }, model); } return new OpenAIAdapter({ ...(secret === undefined ? {} : { apiKey: secret }), ...(baseURL === undefined ? {} : { baseURL }) }, model); }

export function registerAgentRoutes(app: FastifyInstance, registry: WorkspaceRegistry, keychain: Keychain = new KeytarKeychain(), dataDirectory = userPaths().data): void {
  app.put<{ Params: { provider: string } }>("/api/providers/:provider/secret", async (request, reply) => { try { const body = secretBody.parse(request.body); if (!/^(openai|anthropic|openai-compatible)$/u.test(request.params.provider)) return reply.code(400).send({ error: "unknown provider" }); await keychain.set(`provider:${request.params.provider}`, body.secret); return { ok: true }; } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post<{ Params: { provider: string } }>("/api/providers/:provider/test", async (request, reply) => { try { const body = testBody.parse(request.body); if (!/^(openai|anthropic|openai-compatible)$/u.test(request.params.provider)) return reply.code(400).send({ error: "unknown provider" }); const secret = (await keychain.get(`provider:${request.params.provider}`)) ?? undefined; const result = await adapter(request.params.provider as ProviderId, secret, body.model, body.baseURL).testConnection(body.model); return result; } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
  app.post("/api/agent/run", async (request, reply) => {
    try {
      const body = runBody.parse(request.body); const record = registry.get(body.workspaceId); const checkpoint = await new GitCheckpointStore().create(record.tree.root.canonicalPath, "theaihatch agent run checkpoint"); const secret = (await keychain.get(`provider:${body.provider}`)) ?? undefined; const selectedAdapter = adapter(body.provider, secret, body.model, body.baseURL); const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-agent-run-")); const writer = await SesWriter.open(sessionDirectory); const tools = createWorkspaceTools(record.tree, writer); const toolByName = new Map(tools.map((tool) => [tool.name, tool])); await fs.mkdir(dataDirectory, { recursive: true }); const repository = new ConversationRepository(path.join(dataDirectory, "conversations.sqlite")); const conversationId = randomUUID(); const runId = randomUUID(); repository.createConversation({ id: conversationId, workspacePath: record.tree.root.canonicalPath, createdAt: new Date().toISOString() }); repository.createRun({ id: runId, conversationId, status: "running", startedAt: new Date().toISOString(), endedAt: null, error: null });
      const runtime = new AgentRuntime(selectedAdapter, { model: body.model, systemPrompt: "You are a local coding agent. Use workspace tools and keep changes reviewable.", tools: tools.map((tool) => ({ name: tool.name, inputSchema: { type: "object" } })) }); const result = await runtime.run({ prompt: body.prompt, executeTool: async (call, signal): Promise<AgentToolResult> => { const tool = toolByName.get(call.name); if (tool === undefined) return { ok: false, content: `unknown tool: ${call.name}`, errorCode: "unknown_tool" }; return tool.execute(call.arguments, signal); }, appendSes: async (event) => { await writer.append(event); return []; } }); for (const message of result.messages.filter((candidate) => candidate.role !== "system")) repository.appendMessage({ id: randomUUID(), conversationId, role: message.role, content: message.content, toolCallId: message.toolCallId ?? null, toolName: message.toolCalls?.[0]?.name ?? null, createdAt: new Date().toISOString() }); repository.saveUsage(runId, { ...result.usage, costUsd: result.costUsd, priceVersion: result.priceVersion }); repository.updateRun(runId, result.status, new Date().toISOString(), result.error); await writer.close(); const reader = await SesReader.open(path.join(sessionDirectory, "events.jsonl")); const events = (await reader.readRange(0, reader.headSeq)).events; repository.close(); return { runId, conversationId, checkpointId: checkpoint.id, status: result.status, usage: result.usage, costUsd: result.costUsd, events };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
