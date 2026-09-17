import { describe, expect, it } from "vitest";
import { McpRegistry } from "../src/registry.js";
import { validateToolArguments } from "../src/tool-policy.js";
import type { McpTransport } from "../src/transports.js";

const transport = (fail = false): McpTransport => ({ connect: async () => { if (fail) throw new Error("offline"); }, close: async () => undefined, listTools: async () => ({ tools: [{ name: "read", inputSchema: { type: "object", required: ["path"] } }] }), listResources: async () => ({ resources: [] }), listPrompts: async () => ({ prompts: [] }), callTool: async (name, args) => ({ content: [{ type: "text", text: `${name}:${String(args.path)}` }] }) });

describe("MCP client", () => {
  it("REQ-MPC-001 and REQ-MPC-002: configures and discovers qualified tools", async () => { const registry = new McpRegistry(); registry.register("one", { type: "stdio", command: "fixture", enabled: true, startupTimeoutMs: 1000 }, transport()); registry.register("two", { type: "stdio", command: "fixture", enabled: true, startupTimeoutMs: 1000 }, transport()); await registry.refresh("one"); await registry.refresh("two"); expect(registry.listTools().map((tool) => tool.qualifiedName)).toEqual(["one/read", "two/read"]); });
  it("REQ-MPC-004 and REQ-MPC-005: denies by policy and validates arguments locally", async () => { const registry = new McpRegistry(); registry.register("one", { type: "stdio", command: "fixture", enabled: true, startupTimeoutMs: 1000 }, transport()); await registry.refresh("one"); expect(await registry.call("one/read", { path: "a" }, "deny")).toEqual({ ok: false, code: "denied" }); expect(validateToolArguments({ type: "object", required: ["path"] }, {})).toEqual({ ok: false, message: "missing required argument: path" }); });
  it("REQ-MPC-006: isolates a failed server", async () => { const registry = new McpRegistry(); registry.register("bad", { type: "stdio", command: "bad", enabled: true, startupTimeoutMs: 1000 }, transport(true)); registry.register("good", { type: "stdio", command: "good", enabled: true, startupTimeoutMs: 1000 }, transport()); await registry.refresh("bad"); await registry.refresh("good"); expect(registry.getStates()).toEqual([{ name: "bad", status: "unavailable", error: "offline" }, { name: "good", status: "connected" }]); });
});
