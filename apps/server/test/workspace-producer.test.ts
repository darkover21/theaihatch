import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { SesReader } from "@theaihatch/ses";
import { createServer } from "../src/app.js";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

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
  } finally {
    await app.close();
  }
});
