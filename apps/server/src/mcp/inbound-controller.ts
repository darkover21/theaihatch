import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createMcpToken, isAcceptedNotification, isUnauthorized, McpController } from "@theaihatch/mcp-server";
import { createWorkspaceTools } from "../agent/ses-recorder.js";
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
    edit_file: async ({ path: filePath, content }) => { const record = registry.latest(); const tool = createWorkspaceTools(record.tree, record.stream).find((candidate) => candidate.name === "edit_file"); if (tool === undefined) throw new Error("edit tool unavailable"); return tool.execute({ path: filePath, content }, new AbortController().signal); },
    save_file: async ({ path: filePath }) => { const record = registry.latest(); const normalized = record.tree.normalize(filePath); const content = await record.tree.readFile(normalized); await registry.emit({ type: "file_save", payload: { path: normalized, contentHash: createHash("sha256").update(content).digest("hex") } }); return { path: normalized, bytes: content.length }; },
    run_command: async ({ command, cwd }) => { const record = registry.latest(); requireCommandApproval(classifyCommand(command, cwd ?? record.tree.root.canonicalPath), false); const tool = createWorkspaceTools(record.tree, record.stream).find((candidate) => candidate.name === "run_command"); if (tool === undefined) throw new Error("command tool unavailable"); return tool.execute({ command, ...(cwd === undefined ? {} : { cwd }) }, new AbortController().signal); },
    animate_step: async ({ label }) => { await registry.emit({ type: "step_begin", payload: { stepId: `mcp-${Date.now()}`, label } }); return { label }; }
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
