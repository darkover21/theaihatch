import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SesReader } from "@theaihatch/ses";
import { WorkspaceStream } from "../src/workspace/workspace-stream.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

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
  await waitFor(() => seen.length === 2, "backfill of the two appended events");
  await stream.close();
  await waitFor(() => seen.length === 3, "the step_end appended by close");
  unsubscribe();
  const reader = await SesReader.open(path.join(data, "sessions", "workspace-1", "events.jsonl"));
  const range = await reader.readRange(0, reader.headSeq);
  expect(range.events.map((event) => event.seq)).toEqual(range.events.map((_, index) => index));
  expect(range.events.at(-1)?.type).toBe("step_end");
  expect(seen).toEqual(range.events.slice(0, 3).map((event) => event.seq));
  expect(reader.integrity).toBe("valid");
});

it("backfills a subscriber gaplessly from disk when fromSeq predates the in-memory tail", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-stream-backfill-"));
  directories.push(data);
  const stream = await WorkspaceStream.open(data, "workspace-2");
  await stream.append({ type: "file_create", payload: { path: "long.txt" } });
  // The tail holds 2000 events, so this run leaves the earliest events readable only from the JSONL.
  for (let index = 0; index < 2400; index += 1) {
    await stream.append({ type: "agent_thought", payload: { text: `t${index}`, visibility: "summary" } });
  }
  const head = stream.headSeq;
  expect(head).toBeGreaterThan(2400);

  const seen: number[] = [];
  const unsubscribe = stream.subscribe(0, (event) => seen.push(event.seq));
  await waitFor(() => seen.length === head + 1, `all ${head + 1} events to reach the subscriber`);

  // Contiguous from 0 with no duplicates: this is exactly what LiveEventSource.append enforces.
  expect(seen).toEqual(Array.from({ length: head + 1 }, (_, index) => index));

  // Events appended during and after the backfill continue in sequence.
  await stream.append({ type: "agent_thought", payload: { text: "after", visibility: "summary" } });
  await waitFor(() => seen.length === head + 2, "the event appended after backfill");
  expect(seen.at(-1)).toBe(head + 1);

  unsubscribe();
  await stream.close();
});

it("resumes mid-stream without replaying earlier events", async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-stream-resume-"));
  directories.push(data);
  const stream = await WorkspaceStream.open(data, "workspace-3");
  for (let index = 0; index < 2200; index += 1) {
    await stream.append({ type: "agent_thought", payload: { text: `t${index}`, visibility: "summary" } });
  }
  const resumeFrom = 5;
  const seen: number[] = [];
  const unsubscribe = stream.subscribe(resumeFrom, (event) => seen.push(event.seq));
  await waitFor(() => seen.length === stream.headSeq - resumeFrom + 1, "the resumed range");
  expect(seen[0]).toBe(resumeFrom);
  expect(seen).toEqual(seen.map((_, index) => resumeFrom + index));
  unsubscribe();
  await stream.close();
});
