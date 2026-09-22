import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionRepository } from "@theaihatch/storage";
import { sessionDirectory, type IntegrityStatus } from "../ses.js";

/**
 * A stream this large is affordable to append to but not to replay: reopening it re-reads and revalidates
 * every event, a backfilling SSE client opens a second reader over it, and the browser rebuilds its step
 * index per appended event. Past these budgets a folder starts a fresh recording rather than resuming.
 */
export const RESUME_MAX_BYTES = 32 * 1024 * 1024;
export const RESUME_MAX_EVENTS = 20_000;

export interface ResolvedSession {
  id: string;
  resumed: boolean;
}

interface LockFile {
  pid: number;
  startedAt: string;
}

function lockPath(dataDirectory: string, sessionId: string): string {
  return path.join(sessionDirectory(dataDirectory, sessionId), "writer.lock");
}

/**
 * SesWriter has no locking, and two writers on one directory produce duplicate sequence numbers that make
 * the stream permanently unreadable past the first duplicate. That was unreachable while every open minted
 * a fresh id; resuming makes ids predictable, so a second process opening the same folder would otherwise
 * land on the same session. A lock naming a live pid blocks the resume; a stale one is reclaimed.
 */
export async function isLocked(dataDirectory: string, sessionId: string): Promise<boolean> {
  const raw = await fs.readFile(lockPath(dataDirectory, sessionId), "utf8").catch(() => null);
  if (raw === null) return false;
  let parsed: LockFile;
  try {
    parsed = JSON.parse(raw) as LockFile;
  } catch {
    return false;
  }
  if (typeof parsed.pid !== "number" || parsed.pid === process.pid) return false;
  try {
    process.kill(parsed.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(dataDirectory: string, sessionId: string): Promise<void> {
  const target = lockPath(dataDirectory, sessionId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies LockFile), "utf8");
}

export async function releaseLock(dataDirectory: string, sessionId: string): Promise<void> {
  await fs.rm(lockPath(dataDirectory, sessionId), { force: true });
}

/**
 * Finds the session a folder should continue, creating a metadata row when it starts a new one. Falls back
 * to a fresh session whenever the prior one cannot be trusted or replayed, so a corrupt or oversized
 * recording never blocks opening the folder.
 */
export async function resolveSession(sessions: SessionRepository, dataDirectory: string, canonicalRoot: string): Promise<ResolvedSession> {
  const previous = sessions.findLatestByWorkspacePath(canonicalRoot);
  if (previous !== null && await isResumable(previous.id, previous.headSeq, previous.integrity, previous.status, dataDirectory)) {
    return { id: previous.id, resumed: true };
  }
  if (previous !== null) sessions.markEnded(previous.id, previous.status === "running" ? "completed" : previous.status);
  const id = randomUUID();
  sessions.create({ id, workspacePath: canonicalRoot });
  return { id, resumed: false };
}

async function isResumable(id: string, headSeq: number, integrity: IntegrityStatus | "unchecked", status: string, dataDirectory: string): Promise<boolean> {
  if (integrity === "corrupt" || status === "failed") return false;
  if (headSeq > RESUME_MAX_EVENTS) return false;
  const streamPath = path.join(sessionDirectory(dataDirectory, id), "events.jsonl");
  const stat = await fs.stat(streamPath).catch(() => null);
  if (stat === null || stat.size > RESUME_MAX_BYTES) return false;
  return !(await isLocked(dataDirectory, id));
}

/**
 * Keeps the metadata row roughly current without writing to SQLite once per typed character: every
 * checkpoint is an exact durable anchor, and a trailing debounce bounds staleness between them.
 */
export class SessionProgressReporter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { headSeq: number; durationMs: number } | null = null;

  constructor(
    private readonly sessions: SessionRepository,
    private readonly sessionId: string,
    private readonly integrity: IntegrityStatus,
    private readonly debounceMs = 2_000
  ) {}

  record(headSeq: number, durationMs: number, isCheckpoint: boolean): void {
    this.pending = { headSeq, durationMs };
    if (isCheckpoint) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref();
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const { headSeq, durationMs } = this.pending;
    this.pending = null;
    try {
      this.sessions.updateProgress(this.sessionId, headSeq, durationMs, this.integrity);
    } catch {
      // Progress is a convenience for listing sessions; the JSONL remains the source of truth.
    }
  }
}
