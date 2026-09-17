import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SesReader, SesWriter, validateSesEvent } from "../src/index.js";

async function tempDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-ses-"));
}

describe("session event stream", () => {
  it("REQ-SES-001: validates payloads and assigns contiguous sequence and time", async () => {
    const directory = await tempDirectory();
    const writer = await SesWriter.open(directory, { clock: () => 1000, sessionStartMs: 1000 });
    const [event] = await writer.append({ type: "workspace_open", payload: { rootName: "demo", canonicalRoot: "." } });
    expect(event?.seq).toBe(0);
    expect(event?.t).toBe(0);
    await expect(writer.append({ seq: 4, type: "workspace_open", payload: { rootName: "bad", canonicalRoot: "." } })).rejects.toThrow();
    await writer.close();
  });

  it("REQ-SES-002: appends UTF-8 JSONL without rewriting committed bytes", async () => {
    const directory = await tempDirectory();
    const writer = await SesWriter.open(directory);
    await writer.append({ type: "workspace_open", payload: { rootName: "demo", canonicalRoot: "." } });
    await writer.flush();
    const stream = path.join(directory, "events.jsonl");
    const before = await fs.readFile(stream);
    await writer.append({ type: "agent_thought", payload: { text: "héllo", visibility: "summary" } });
    await writer.close();
    const after = await fs.readFile(stream);
    expect(after.subarray(0, before.length)).toEqual(before);
    expect((await SesReader.open(stream)).headSeq).toBe(1);
  });

  it("REQ-SES-003 and REQ-SES-004: reads bounded ranges and retains every appended event", async () => {
    const directory = await tempDirectory();
    const writer = await SesWriter.open(directory);
    for (let index = 0; index < 1000; index += 1) await writer.append({ type: "agent_thought", payload: { text: String(index), visibility: "hidden" } });
    await writer.close();
    const reader = await SesReader.open(path.join(directory, "events.jsonl"));
    const range = await reader.readRange(20, 29);
    expect(range.events.map((event) => event.seq)).toEqual(Array.from({ length: 10 }, (_, index) => index + 20));
    expect(range.headSeq).toBe(1001);
  });

  it("REQ-SES-005: emits a complete touched-file checkpoint after 500 non-checkpoint events", async () => {
    const directory = await tempDirectory();
    const writer = await SesWriter.open(directory);
    await writer.append({ type: "file_create", payload: { path: "src/app.ts" } });
    for (let index = 0; index < 498; index += 1) await writer.append({ type: "agent_thought", payload: { text: String(index), visibility: "hidden" } });
    const committed = await writer.append({ type: "agent_thought", payload: { text: "last", visibility: "hidden" } });
    expect(committed.map((event) => event.type)).toEqual(["agent_thought", "checkpoint"]);
    expect(committed[1]?.type === "checkpoint" ? committed[1].payload.files[0]?.path : undefined).toBe("src/app.ts");
    await writer.close();
  });

  it("REQ-SES-006: finds the nearest checkpoint before a target", async () => {
    const directory = await tempDirectory();
    const writer = await SesWriter.open(directory);
    await writer.append({ type: "file_create", payload: { path: "a.txt" } });
    await writer.append({ type: "edit_insert", payload: { path: "a.txt", position: { line: 0, column: 0 }, text: "one" } });
    await writer.appendCheckpoint();
    await writer.append({ type: "edit_insert", payload: { path: "a.txt", position: { line: 0, column: 3 }, text: " two" } });
    await writer.close();
    const reader = await SesReader.open(path.join(directory, "events.jsonl"));
    expect(reader.getCheckpointAtOrBefore(3)?.seq).toBe(2);
    expect((await reader.seekWindow(3)).events.map((event) => event.seq)).toEqual([3]);
  });

  it("REQ-SES-007: quarantines only a malformed final JSON line", async () => {
    const directory = await tempDirectory();
    const stream = path.join(directory, "events.jsonl");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(stream, `${JSON.stringify({ seq: 0, t: 0, type: "agent_thought", payload: { text: "ok", visibility: "hidden" } })}\n{"seq":`, "utf8");
    const reader = await SesReader.open(stream);
    expect(reader.integrity).toBe("recovered");
    expect(reader.headSeq).toBe(0);
    expect((await fs.readFile(path.join(directory, "recovery.jsonl"), "utf8")).includes('"seq":')).toBe(true);
  });

  it("REQ-SES-009: rejects traversal paths before filesystem access", () => {
    expect(() => validateSesEvent({ seq: 0, t: 0, type: "file_create", payload: { path: "../escape" } })).toThrow();
  });
});
