import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { SesReader } from "@theaihatch/ses";
import { createServer } from "../src/app.js";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

async function readStream(streamPath: string): Promise<Array<{ type: string }>> {
  const reader = await SesReader.open(streamPath);
  return (await reader.readRange(0, reader.headSeq)).events;
}

async function settledStream(streamPath: string, settleMs = 600): Promise<Array<{ type: string }>> {
  const deadline = Date.now() + 5_000;
  let previous = -1;
  let stableSince = Date.now();
  let events: Array<{ type: string }> = [];
  while (Date.now() < deadline) {
    events = await readStream(streamPath);
    if (events.length !== previous) { previous = events.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= settleMs) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return events;
}

it("records an external filesystem edit in the workspace stream when enabled", async () => {
  vi.stubEnv("THEAIHATCH_WATCH_PRODUCER", "1");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-producer-root-"));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-producer-data-"));
  directories.push(root, data);
  const app = createServer(undefined, "test-token", undefined, data);
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const opened = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: root }) });
    const id = ((await opened.json()) as { id: string }).id;
    await fs.writeFile(path.join(root, "external.ts"), "export const live = true;\n", "utf8");
    const streamPath = path.join(data, "sessions", id, "events.jsonl");
    const deadline = Date.now() + 3_000;
    let events: Array<{ type: string }> = [];
    while (Date.now() < deadline) {
      const reader = await SesReader.open(streamPath);
      events = (await reader.readRange(0, reader.headSeq)).events;
      if (events.some((event) => event.type === "file_save")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["step_begin", "file_create", "file_open", "edit_insert", "file_save", "step_end"]));
    const settled = await settledStream(streamPath);
    expect(settled.filter((event) => event.type === "step_begin")).toHaveLength(1);
  } finally {
    await app.close();
  }
});

it("does not open an external step for a tool write the stream already recorded", async () => {
  vi.stubEnv("THEAIHATCH_WATCH_PRODUCER", "1");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-echo-root-"));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-echo-data-"));
  directories.push(root, data);
  const app = createServer(undefined, "test-token", undefined, data);
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const opened = await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: root }) });
    const id = ((await opened.json()) as { id: string }).id;
    const call = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit_file", arguments: { path: "tool.ts", content: "export const viaTool = true;\n" } } })
    });
    expect(call.status).toBe(200);
    const events = await settledStream(path.join(data, "sessions", id, "events.jsonl"));
    expect(events.filter((event) => event.type === "step_begin")).toHaveLength(1);
    expect(events.filter((event) => event.type === "file_save")).toHaveLength(1);
    expect(events.filter((event) => event.type === "edit_insert")).toHaveLength(1);
  } finally {
    await app.close();
  }
});
