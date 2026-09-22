import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SesReader, SesWriter } from "../../src/index.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hatch-bench-"));
const writer = await SesWriter.open(dir);
const body = "const x = 1;\n".repeat(120);
const FILES = 4000;
for (let i = 0; i < FILES; i += 1) {
  const f = `src/file-${String(i).padStart(4, "0")}.ts`;
  await writer.append({ type: "file_create", payload: { path: f } });
  await writer.append({ type: "edit_insert", payload: { path: f, position: { line: 0, column: 0 }, text: body } });
  await writer.append({ type: "file_save", payload: { path: f, contentHash: "h" } });
}
await writer.close();
const streamPath = path.join(dir, "events.jsonl");
const bytes = (await fs.stat(streamPath)).size;
const reader = await SesReader.open(streamPath);
const events = (await reader.readRange(0, reader.headSeq)).events;
const cps = events.filter((e) => e.type === "checkpoint");
const full = cps.filter((e) => e.type === "checkpoint" && e.payload.reason !== "delta").length;
const cpBytes = cps.reduce((n, e) => n + JSON.stringify(e).length, 0);

// Old behaviour: every checkpoint restated every file touched so far.
let old = 0;
const touched = new Set<string>();
const size = new Map<string, number>();
for (const e of events) {
  if (e.type === "file_create") { touched.add(e.payload.path); size.set(e.payload.path, 0); }
  else if (e.type === "edit_insert") size.set(e.payload.path, (size.get(e.payload.path) ?? 0) + e.payload.text.length);
  else if (e.type === "checkpoint") for (const p of touched) old += (size.get(p) ?? 0) + p.length + 40;
}

console.log(`events=${events.length}  payload=${(FILES * body.length / 1e6).toFixed(1)}MB  stream=${(bytes / 1e6).toFixed(1)}MB`);
console.log(`checkpoints=${cps.length} (full=${full}, delta=${cps.length - full})`);
console.log(`checkpoint bytes NOW = ${(cpBytes / 1e6).toFixed(1)}MB`);
console.log(`checkpoint bytes BEFORE = ${(old / 1e6).toFixed(1)}MB   (${(old / Math.max(cpBytes, 1)).toFixed(1)}x)`);
await fs.rm(dir, { recursive: true, force: true });
