import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SesReader, SesWriter } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

async function makeDir(label: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `theaihatch-${label}-`));
  directories.push(directory);
  return directory;
}

// A full checkpoint restates every file ever touched. Emitting one every 500 events made stream size grow
// with the square of the event count: a real session reached 1.1 GB of checkpoints across 84 of them.
it("keeps checkpoint bytes near-linear as a session touches many files", async () => {
  const directory = await makeDir("growth");
  const writer = await SesWriter.open(directory);
  const body = "x".repeat(4_000);
  for (let index = 0; index < 400; index += 1) {
    const file = `src/file-${String(index).padStart(4, "0")}.ts`;
    await writer.append({ type: "file_create", payload: { path: file } });
    await writer.append({ type: "edit_insert", payload: { path: file, position: { line: 0, column: 0 }, text: body } });
    await writer.append({ type: "file_save", payload: { path: file, contentHash: "h" } });
  }
  await writer.close();

  const streamPath = path.join(directory, "events.jsonl");
  const bytes = (await fs.stat(streamPath)).size;
  const payload = 400 * body.length;

  // Every file's content is written once as an edit and at most about twice more across checkpoints.
  // The old full-checkpoint-every-500-events behaviour produced roughly 20x the payload here.
  expect(bytes).toBeLessThan(payload * 5);

  const reader = await SesReader.open(streamPath);
  expect(reader.integrity).toBe("valid");
  const checkpoints = (await reader.readRange(0, reader.headSeq)).events.filter((event) => event.type === "checkpoint");
  expect(checkpoints.length).toBeGreaterThan(1);
  expect(checkpoints.some((event) => event.type === "checkpoint" && event.payload.reason === "delta")).toBe(true);
});

// Seeking restores from a full checkpoint and then replays forward, so a delta in between must apply as a
// delta. If a delta were ever chosen as the restore anchor, every file it omitted would silently vanish.
it("reconstructs identical file state across delta checkpoints", async () => {
  const directory = await makeDir("delta");
  const writer = await SesWriter.open(directory);
  const expected = new Map<string, string>();
  // Past several 500-event cadence boundaries, so the stream contains both full and delta checkpoints.
  for (let index = 0; index < 600; index += 1) {
    const file = `src/file-${String(index).padStart(3, "0")}.ts`;
    const content = `const value${index} = ${index};\n`.repeat(20);
    await writer.append({ type: "file_create", payload: { path: file } });
    await writer.append({ type: "edit_insert", payload: { path: file, position: { line: 0, column: 0 }, text: content } });
    await writer.append({ type: "file_save", payload: { path: file, contentHash: "h" } });
    expected.set(file, content);
  }
  await writer.close();

  // A fresh writer replays the whole stream to rebuild its projection, which is exactly the resume path.
  const reopened = await SesWriter.open(directory);
  try {
    expect(new Map([...reopened.currentFiles].filter(([, content]) => content !== null) as Array<[string, string]>)).toEqual(expected);
  } finally {
    await reopened.close();
  }

  const reader = await SesReader.open(path.join(directory, "events.jsonl"));
  const anchor = reader.getCheckpointAtOrBefore(reader.headSeq);
  expect(anchor?.type).toBe("checkpoint");
  expect(anchor !== null && anchor.type === "checkpoint" && anchor.payload.reason).not.toBe("delta");
});
