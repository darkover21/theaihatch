import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpTransport, type McpTransport } from "@theaihatch/mcp-client";
import { createServer } from "../src/app.js";
import type { SesEventInput } from "../src/ses.js";

const token = "e2e-token";
const events: SesEventInput[] = [];

let app: FastifyInstance;
let baseUrl: string;
let workspaceRoot: string;
let dataDirectory: string;
let workspaceId: string;
let client: McpTransport;

const postMcp = (body: unknown, authorization = `Bearer ${token}`): Promise<Response> => fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body) });

beforeAll(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-mcp-e2e-"));
  await fs.writeFile(path.join(workspaceRoot, "notes.txt"), "before\n", "utf8");
  // An explicit data directory keeps session streams out of the real user data directory.
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-mcp-e2e-data-"));
  app = createServer((event) => { events.push(event); }, token, undefined, dataDirectory);
  await app.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const opened = await fetch(`${baseUrl}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: workspaceRoot }) });
  workspaceId = ((await opened.json()) as { id: string }).id;
  client = createMcpTransport("theaihatch", { url: `${baseUrl}/mcp`, headers: { Authorization: `Bearer ${token}` } });
  await client.connect();
});

afterAll(async () => {
  await client.close();
  await fetch(`${baseUrl}/api/workspaces/${workspaceId}`, { method: "DELETE" });
  await app.close();
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

describe("inbound MCP over streamable HTTP", () => {
  it("REQ-MPS-001 and REQ-MPS-003: completes the official-SDK handshake and publishes every platform tool", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["open_file", "edit_file", "save_file", "run_command", "animate_step"]);
    expect(tools.tools.every((tool) => (tool.inputSchema as { type: string }).type === "object")).toBe(true);
  });

  it("REQ-MPS-001: accepts an id-less notification and declines a server-initiated stream without failing the session", async () => {
    const accepted = await postMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(accepted.status).toBe(202);
    expect((await accepted.text()).trim()).toBe("");
    expect((await fetch(`${baseUrl}/mcp`, { method: "GET", headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });

  it("REQ-MPS-002: refuses an invalid token with an unauthorized status and runs no tool", async () => {
    const response = await postMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "animate_step", arguments: { label: "unauthorized" } } }, "Bearer wrong");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32001);
    expect(events.some((event) => event.type === "step_begin" && (event.payload as { label: string }).label === "unauthorized")).toBe(false);
  });

  it("REQ-MPS-004: drives visible steps and granular edit events through the session stream", async () => {
    await client.callTool("animate_step", { label: "external drive" });
    expect(events.some((event) => event.type === "step_begin" && (event.payload as { label: string }).label === "external drive")).toBe(true);

    const before = events.length;
    await client.callTool("edit_file", { path: "notes.txt", content: "after\n" });
    expect(await fs.readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("after\n");
    const edits = events.slice(before).map((event) => event.type);
    expect(edits.some((type) => type.startsWith("edit_"))).toBe(true);
    expect(edits).toContain("file_save");
  });

  it("REQ-MPS-003: rejects schema-invalid arguments without touching the workspace", async () => {
    await expect(client.callTool("edit_file", { path: "notes.txt" })).rejects.toThrow();
    expect(await fs.readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("after\n");
  });

  it("records a human PUT /file as a replayable edit", async () => {
    const before = events.length;
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/file`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "notes.txt", content: "human save\n" }) });
    expect(response.status).toBe(200);
    expect(events.slice(before).map((event) => event.type)).toEqual(expect.arrayContaining(["file_open", "edit_replace", "file_save"]));
  });

  it("REQ-MPS-006: runs an approved command and holds a destructive one for local approval", async () => {
    const before = events.length;
    await client.callTool("run_command", { command: "echo mcp-e2e" });
    expect(events.slice(before).some((event) => event.type === "terminal_output")).toBe(true);
    await expect(client.callTool("run_command", { command: "rm -rf ." })).rejects.toThrow(/approval required/u);
  });
});
