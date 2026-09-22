import { promises as fs } from "node:fs";
import path from "node:path";
import { userPaths } from "@theaihatch/packaging";
import { SesReader } from "../ses.js";

interface SessionSummary {
  id: string;
  directory: string;
  bytes: number;
  headSeq: number;
  workspacePath: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} kB`;
}

// Reading only the first line avoids loading a multi-gigabyte stream just to identify its workspace.
async function firstWorkspacePath(streamPath: string): Promise<string> {
  const handle = await fs.open(streamPath, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(10);
    const line = buffer.subarray(0, newline === -1 ? bytesRead : newline).toString("utf8");
    const parsed = JSON.parse(line) as { type?: string; payload?: { canonicalRoot?: string } };
    return parsed.type === "workspace_open" && typeof parsed.payload?.canonicalRoot === "string" ? parsed.payload.canonicalRoot : "(unknown)";
  } catch {
    return "(unreadable)";
  } finally {
    await handle.close();
  }
}

async function summarize(sessionsDirectory: string): Promise<SessionSummary[]> {
  const entries = await fs.readdir(sessionsDirectory, { withFileTypes: true }).catch(() => []);
  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(sessionsDirectory, entry.name);
    const streamPath = path.join(directory, "events.jsonl");
    const stat = await fs.stat(streamPath).catch(() => null);
    if (stat === null) { summaries.push({ id: entry.name, directory, bytes: 0, headSeq: -1, workspacePath: "(no stream)" }); continue; }
    // A small stream is cheap to parse for an exact head; a large one is identified by size alone.
    let headSeq = -1;
    if (stat.size <= 8_000_000) headSeq = (await SesReader.open(streamPath).then((reader) => reader.headSeq, () => -1));
    summaries.push({ id: entry.name, directory, bytes: stat.size, headSeq, workspacePath: await firstWorkspacePath(streamPath) });
  }
  return summaries.sort((left, right) => right.bytes - left.bytes);
}

const apply = process.argv.includes("--yes");
const sessionsDirectory = path.join(userPaths().data, "sessions");
const summaries = await summarize(sessionsDirectory);
const total = summaries.reduce((sum, entry) => sum + entry.bytes, 0);

console.log(`${sessionsDirectory}\n${summaries.length} sessions, ${formatBytes(total)}\n`);
for (const entry of summaries) {
  console.log(`${formatBytes(entry.bytes).padStart(10)}  head=${String(entry.headSeq).padStart(6)}  ${entry.id}  ${entry.workspacePath}`);
}

// Only sessions that recorded nothing are ever proposed for deletion. A session with real events is a
// recording the user may still want, however large; deleting those is their call, not this script's.
const empty = summaries.filter((entry) => entry.headSeq <= 0 && entry.bytes < 8_000_000);
console.log(`\n${empty.length} sessions recorded nothing (${formatBytes(empty.reduce((sum, entry) => sum + entry.bytes, 0))}).`);
if (empty.length === 0) process.exit(0);
if (!apply) {
  console.log("Re-run with --yes to delete them. Sessions holding real events are never deleted by this script.");
  process.exit(0);
}
for (const entry of empty) await fs.rm(entry.directory, { recursive: true, force: true });
console.log(`Deleted ${empty.length} empty sessions.`);
