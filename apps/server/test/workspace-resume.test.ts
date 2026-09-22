import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SesReader } from "@theaihatch/ses";
import { SessionRepository } from "@theaihatch/storage";
import { WorkspaceRegistry } from "../src/routes/workspaces.js";
import { acquireLock, RESUME_MAX_BYTES } from "../src/workspace/session-store.js";

// Far above the default pid_max on macOS and Linux, so nothing is running under it.
const DEAD_PID = 4_194_301;

const directories: string[] = [];
const registries: WorkspaceRegistry[] = [];

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.closeAll().catch(() => undefined);
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function makeDir(label: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `theaihatch-resume-${label}-`));
  directories.push(directory);
  return directory;
}

function registry(dataDirectory: string): WorkspaceRegistry {
  const created = new WorkspaceRegistry(undefined, dataDirectory);
  registries.push(created);
  return created;
}

async function streamEvents(dataDirectory: string, id: string): Promise<Array<{ seq: number; type: string }>> {
  const reader = await SesReader.open(path.join(dataDirectory, "sessions", id, "events.jsonl"));
  expect(reader.integrity).toBe("valid");
  return (await reader.readRange(0, reader.headSeq)).events.map((event) => ({ seq: event.seq, type: event.type }));
}

it("returns the same record when a folder already open is opened again", async () => {
  const data = await makeDir("idempotent-data");
  const root = await makeDir("idempotent-root");
  const active = registry(data);

  const first = await active.open(root);
  const second = await active.open(root);

  expect(second.id).toBe(first.id);
  expect(second).toBe(first);
  // A second record would mean a second watcher and a second writer over one session directory.
  const events = await streamEvents(data, first.id);
  expect(events.filter((event) => event.type === "workspace_open")).toHaveLength(1);
});

it("resumes a folder's prior session after the server restarts", async () => {
  const data = await makeDir("resume-data");
  const root = await makeDir("resume-root");

  const before = registry(data);
  const opened = await before.open(root);
  await opened.stream.append({ type: "step_begin", payload: { stepId: "step-1", label: "Edit a.ts" } });
  await opened.stream.append({ type: "file_create", payload: { path: "a.ts" } });
  await opened.stream.append({ type: "step_end", payload: { stepId: "step-1", outcome: "succeeded" } });
  const headBefore = opened.stream.headSeq;
  await before.close(opened.id);

  // A fresh registry over the same data directory is what a restarted server looks like.
  const after = registry(data);
  const reopened = await after.open(root);

  expect(reopened.id).toBe(opened.id);
  expect(reopened.resumed).toBe(true);
  // The reopen appends its own workspace_open, so the head advances rather than restarting at zero.
  expect(reopened.stream.headSeq).toBe(headBefore + 1);

  const events = await streamEvents(data, reopened.id);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
  expect(events.filter((event) => event.type === "step_begin")).toHaveLength(1);

  // A client reconnecting from zero sees the whole history, which is what restores the STEPS list.
  const seen: number[] = [];
  const unsubscribe = reopened.stream.subscribe(0, (event) => seen.push(event.seq));
  const deadline = Date.now() + 3_000;
  while (seen.length <= headBefore + 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  unsubscribe();
  expect(seen).toEqual(events.map((event) => event.seq));
});

it("starts a new session rather than resuming an oversized recording", async () => {
  const data = await makeDir("oversize-data");
  const root = await makeDir("oversize-root");

  const before = registry(data);
  const opened = await before.open(root);
  await before.close(opened.id);

  // Replaying a stream this large costs more than it is worth, so the folder starts a fresh recording.
  const streamPath = path.join(data, "sessions", opened.id, "events.jsonl");
  const original = await fs.readFile(streamPath);
  await fs.appendFile(streamPath, Buffer.alloc(RESUME_MAX_BYTES + 1, " "));

  const after = registry(data);
  const reopened = await after.open(root);

  expect(reopened.id).not.toBe(opened.id);
  expect(reopened.resumed).toBe(false);
  // The prior recording is left exactly as it was; nothing prunes it automatically.
  expect((await fs.readFile(streamPath)).subarray(0, original.length)).toEqual(original);

  const sessions = new SessionRepository(data);
  try {
    expect(sessions.findLatestByWorkspacePath(reopened.tree.root.canonicalPath)?.id).toBe(reopened.id);
    expect(sessions.get(opened.id).status).toBe("completed");
  } finally {
    sessions.close();
  }
});

it("refuses to resume a session another live process holds", async () => {
  const data = await makeDir("lock-data");
  const root = await makeDir("lock-root");

  const before = registry(data);
  const opened = await before.open(root);
  await before.close(opened.id);

  // A lock naming a live process that is not this one: two writers would corrupt the stream.
  await fs.writeFile(
    path.join(data, "sessions", opened.id, "writer.lock"),
    JSON.stringify({ pid: await liveForeignPid(), startedAt: new Date().toISOString() }),
    "utf8"
  );

  const after = registry(data);
  const reopened = await after.open(root);
  expect(reopened.id).not.toBe(opened.id);
});

it("reclaims a lock left behind by a process that died", async () => {
  const data = await makeDir("stale-data");
  const root = await makeDir("stale-root");

  const before = registry(data);
  const opened = await before.open(root);
  await before.close(opened.id);

  await acquireLock(data, opened.id);
  await fs.writeFile(
    path.join(data, "sessions", opened.id, "writer.lock"),
    JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString() }),
    "utf8"
  );

  const after = registry(data);
  const reopened = await after.open(root);
  expect(reopened.id).toBe(opened.id);
  expect(reopened.resumed).toBe(true);
});

it("records session metadata without scanning the stream", async () => {
  const data = await makeDir("metadata-data");
  const root = await makeDir("metadata-root");
  const active = registry(data);

  const opened = await active.open(root);
  // A checkpoint flushes progress immediately, so the row is exact without waiting for the debounce.
  await opened.stream.append({ type: "checkpoint", payload: { reason: "final", files: [] } });

  const sessions = new SessionRepository(data);
  try {
    const row = sessions.get(opened.id);
    expect(row.workspacePath).toBe(opened.tree.root.canonicalPath);
    expect(row.status).toBe("running");
    expect(row.startedAt).not.toBeNull();
    expect(row.headSeq).toBe(opened.stream.headSeq);
    // REQ-SES-009: metadata points at a relative stream path, and the session directory carries its index.
    expect(path.isAbsolute(row.streamPath)).toBe(false);
    await expect(fs.stat(path.join(data, "sessions", opened.id, "index.sqlite"))).resolves.toBeTruthy();
  } finally {
    sessions.close();
  }

  await active.close(opened.id);
  const closed = new SessionRepository(data);
  try {
    expect(closed.get(opened.id).status).toBe("completed");
    expect(closed.get(opened.id).endedAt).not.toBeNull();
  } finally {
    closed.close();
  }
});

// A pid that certainly exists and is not this process: the parent that spawned the test runner.
async function liveForeignPid(): Promise<number> {
  return process.ppid;
}
