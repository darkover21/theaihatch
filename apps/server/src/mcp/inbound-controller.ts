import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createMcpToken, isAcceptedNotification, isUnauthorized, McpController } from "@theaihatch/mcp-server";
import { createWorkspaceTools } from "../agent/ses-recorder.js";
import { SesReader, SesWriter } from "../ses.js";
import type { WorkspaceRegistry } from "../routes/workspaces.js";
import { classifyCommand, requireCommandApproval } from "@theaihatch/safety";

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function loopbackAddress(request: FastifyRequest): string | null {
  const remote = request.raw.socket.remoteAddress;
  return remote !== undefined && loopbackAddresses.has(remote) ? remote : null;
}

export function registerInboundMcp(app: FastifyInstance, registry: WorkspaceRegistry, token = createMcpToken()): { token: string } {
  const controller = new McpController({ token, handlers: {
    open_file: async ({ path: filePath }) => registry.latest().tree.readFile(registry.latest().tree.normalize(filePath)),
    edit_file: async ({ path: filePath, content }) => {
      const record = registry.latest(); const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-mcp-")); const writer = await SesWriter.open(directory); try { const tool = createWorkspaceTools(record.tree, writer).find((candidate) => candidate.name === "edit_file"); if (tool === undefined) throw new Error("edit tool unavailable"); const result = await tool.execute({ path: filePath, content }, new AbortController().signal); await writer.close(); const reader = await SesReader.open(path.join(directory, "events.jsonl")); for (const event of (await reader.readRange(0, reader.headSeq)).events) registry.emit(event); return result; } finally { await writer.close(); }
    },
    save_file: async ({ path: filePath }) => { const record = registry.latest(); const normalized = record.tree.normalize(filePath); const content = await record.tree.readFile(normalized); registry.emit({ type: "file_save", payload: { path: normalized, contentHash: "mcp-save" } }); return { path: normalized, bytes: content.length }; },
    run_command: async ({ command, cwd }) => { const record = registry.latest(); requireCommandApproval(classifyCommand(command, cwd ?? record.tree.root.canonicalPath), false); const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-mcp-")); const writer = await SesWriter.open(directory); try { const tool = createWorkspaceTools(record.tree, writer).find((candidate) => candidate.name === "run_command"); if (tool === undefined) throw new Error("command tool unavailable"); const result = await tool.execute({ command, ...(cwd === undefined ? {} : { cwd }) }, new AbortController().signal); await writer.close(); const reader = await SesReader.open(path.join(directory, "events.jsonl")); for (const event of (await reader.readRange(0, reader.headSeq)).events) registry.emit(event); return result; } finally { await writer.close(); } },
    animate_step: async ({ label }) => { registry.emit({ type: "step_begin", payload: { stepId: `mcp-${Date.now()}`, label } }); return { label }; }
  } });
  app.post("/mcp", async (request, reply) => {
    const remote = loopbackAddress(request);
    if (remote === null) return reply.code(403).send({ error: "MCP accepts loopback clients only" });
    const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
    const client = typeof request.headers["x-theaihatch-client"] === "string" ? request.headers["x-theaihatch-client"] : remote;
    const outcome = await controller.handle(request.body, authorization, client);
    // A notification carries no id, so streamable HTTP expects an accepted status with no body.
    if (isAcceptedNotification(outcome)) return reply.code(202).send();
    if (isUnauthorized(outcome)) return reply.code(401).header("www-authenticate", "Bearer").send(outcome);
    return outcome;
  });

  // This endpoint is stateless and never offers a server-initiated stream. Streamable HTTP clients
  // treat 405 as "no stream here" and keep the session, while a 404 aborts them with an error.
  app.get("/mcp", async (request, reply) => loopbackAddress(request) === null ? reply.code(403).send({ error: "MCP accepts loopback clients only" }) : reply.code(405).send({ error: "MCP streaming is not offered" }));
  app.delete("/mcp", async (request, reply) => loopbackAddress(request) === null ? reply.code(403).send({ error: "MCP accepts loopback clients only" }) : reply.code(405).send({ error: "MCP sessions are not terminable" }));
  return { token };
}
