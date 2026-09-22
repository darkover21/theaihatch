import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createServer } from "../src/app.js";
import type { WorkspaceRegistry } from "../src/routes/workspaces.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

it("streams workspace events and app.close does not wait on an attached client", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-sse-root-"));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-sse-data-"));
  directories.push(root, data);
  const app = createServer(undefined, "test-token", undefined, data);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const opened = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: root }) });
    const workspaceId = ((await opened.json()) as { id: string }).id;
    const controller = new AbortController();
    const response = await fetch(`${base}/api/workspaces/${workspaceId}/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: hello");
    const registry = (app as unknown as FastifyWorkspaceApp).workspaceRegistry;
    await registry.get(workspaceId).stream.append({ type: "agent_thought", payload: { text: "live", visibility: "summary" } });
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain('"type":"agent_thought"');
    await reader.cancel();
    controller.abort();
    await expect(app.close()).resolves.toBeUndefined();
  } finally {
    if (app.server.listening) await app.close();
  }
});

interface FastifyWorkspaceApp { workspaceRegistry: WorkspaceRegistry; }

it("answers 404 for a workspace id the server no longer has", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-sse-stale-"));
  directories.push(data);
  const app = createServer(undefined, "stale-token", undefined, data);
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // A 500 here closes an EventSource permanently with no retry, so the page stops updating silently.
    const response = await fetch(`${base}/api/workspaces/a65101c5-8466-402e-a877-07a319a6ac7e/events`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toContain("workspace handle is not active");
  } finally {
    await app.close();
  }
});
