import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SesReader } from "@theaihatch/ses";
import { WorkspaceStream } from "../src/workspace/workspace-stream.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

it("serializes concurrent appends, backfills subscribers, and closes open steps", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-workspace-stream-"));
  directories.push(data);
  const stream = await WorkspaceStream.open(data, "workspace-1");
  await Promise.all([
    stream.append({ type: "workspace_open", payload: { rootName: "demo", canonicalRoot: data } }),
    stream.append({ type: "step_begin", payload: { stepId: "step-1", label: "edit" } }),
  ]);
  const seen: number[] = [];
  const unsubscribe = stream.subscribe(0, (event) => seen.push(event.seq));
  await stream.close();
  unsubscribe();
  const reader = await SesReader.open(path.join(data, "sessions", "workspace-1", "events.jsonl"));
  const range = await reader.readRange(0, reader.headSeq);
  expect(range.events.map((event) => event.seq)).toEqual(range.events.map((_, index) => index));
  expect(range.events.at(-1)?.type).toBe("step_end");
  expect(seen).toEqual(range.events.slice(0, 3).map((event) => event.seq));
  expect(reader.integrity).toBe("valid");
});
