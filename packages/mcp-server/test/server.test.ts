import { describe, expect, it } from "vitest";
import { McpController } from "../src/server.js";

const controller = new McpController({ token: "secret", handlers: { open_file: async ({ path }) => path, edit_file: async ({ path }) => path, save_file: async ({ path }) => path, run_command: async ({ command }) => command, animate_step: async ({ label }) => label } });
const request = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0" as const, id: 1, method, ...(params === undefined ? {} : { params }) });

describe("MCP server", () => {
  it("REQ-MPS-002 and REQ-MPS-003: authenticates and lists complete platform tools", async () => { expect((await controller.handle(request("tools/list"), "Bearer wrong", "client")).error?.code).toBe(-32001); const response = await controller.handle(request("tools/list"), "Bearer secret", "client"); expect((response.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(["open_file", "edit_file", "save_file", "run_command", "animate_step"]); });
  it("REQ-MPS-003 and REQ-MPS-005: rejects invalid input and routes a valid call", async () => { expect((await controller.handle(request("tools/call", { name: "edit_file", arguments: {} }), "Bearer secret", "client")).error?.code).toBe(-32602); const response = await controller.handle(request("tools/call", { name: "animate_step", arguments: { label: "visible" } }), "Bearer secret", "client"); expect(response.result).toBeDefined(); });
});
