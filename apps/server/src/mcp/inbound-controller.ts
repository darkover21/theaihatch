import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createMcpToken, McpController } from "@theaihatch/mcp-server";
import { createWorkspaceTools } from "../agent/ses-recorder.js";
import { SesReader, SesWriter } from "../ses.js";
import type { WorkspaceRegistry } from "../routes/workspaces.js";
import { classifyCommand, requireCommandApproval } from "@theaihatch/safety";

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
  app.post("/mcp", async (request, reply) => { const remote = request.raw.socket.remoteAddress; if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") return reply.code(403).send({ error: "MCP accepts loopback clients only" }); const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined; const client = typeof request.headers["x-theaihatch-client"] === "string" ? request.headers["x-theaihatch-client"] : remote ?? "loopback"; return controller.handle(request.body, authorization, client); });
  return { token };
}
