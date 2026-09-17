import { z } from "zod";
import type { McpPolicy } from "./registry.js";

export function validateToolArguments(inputSchema: Record<string, unknown>, value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, message: "MCP tool arguments must be an object" };
  const record = value as Record<string, unknown>;
  const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((item): item is string => typeof item === "string") : [];
  for (const key of required) if (!(key in record)) return { ok: false, message: `missing required argument: ${key}` };
  return { ok: true, value: record };
}

export const policySchema = z.enum(["always_ask", "allow", "deny"]);
export function canExecute(policy: McpPolicy, approved: boolean): boolean { return policy === "allow" || (policy === "always_ask" && approved); }
