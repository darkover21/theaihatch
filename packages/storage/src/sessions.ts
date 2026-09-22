import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { SessionId, SessionMetadata } from "@theaihatch/ses";
import { sessionDirectory } from "@theaihatch/ses";

interface SessionRow {
  id: string;
  workspace_path: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  status: SessionMetadata["status"];
  stream_path: string;
  head_seq: number;
  duration_ms: number;
  provider_id: string | null;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  integrity: SessionMetadata["integrity"];
}

export class SessionRepository {
  private readonly database: Database.Database;

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.database = new Database(path.resolve(dataDir, "sessions.sqlite"));
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        status TEXT NOT NULL,
        stream_path TEXT NOT NULL,
        head_seq INTEGER NOT NULL DEFAULT -1,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        provider_id TEXT,
        model_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        integrity TEXT NOT NULL DEFAULT 'unchecked'
      )
    `);
    // Resuming a workspace looks its prior session up by folder, which is the only non-primary-key
    // lookup this table serves. Creating it here keeps existing databases working without a migration.
    this.database.exec("CREATE INDEX IF NOT EXISTS sessions_workspace_path ON sessions(workspace_path)");
  }

  create(input: Pick<SessionMetadata, "id" | "workspacePath"> & Partial<Pick<SessionMetadata, "providerId" | "modelId">>): SessionMetadata {
    const sessionPath = sessionDirectory(this.dataDir, input.id);
    mkdirSync(sessionPath, { recursive: true });
    const indexDatabase = new Database(path.join(sessionPath, "index.sqlite"));
    indexDatabase.exec(`
      CREATE TABLE IF NOT EXISTS event_index (
        seq INTEGER PRIMARY KEY,
        timestamp_ms INTEGER NOT NULL,
        type TEXT NOT NULL,
        byte_start INTEGER NOT NULL,
        byte_end INTEGER NOT NULL
      )
    `);
    indexDatabase.close();
    const now = new Date().toISOString();
    const streamPath = path.relative(this.dataDir, path.join(sessionPath, "events.jsonl"));
    this.database.prepare(`
      INSERT INTO sessions (id, workspace_path, created_at, status, stream_path, provider_id, model_id)
      VALUES (@id, @workspacePath, @createdAt, 'created', @streamPath, @providerId, @modelId)
    `).run({ id: input.id, workspacePath: input.workspacePath, createdAt: now, streamPath, providerId: input.providerId ?? null, modelId: input.modelId ?? null });
    return this.get(input.id);
  }

  get(id: SessionId): SessionMetadata {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (row === undefined) throw new Error(`session not found: ${id}`);
    return this.toMetadata(row);
  }

  list(): SessionMetadata[] {
    const rows = this.database.prepare("SELECT * FROM sessions ORDER BY created_at ASC").all() as SessionRow[];
    return rows.map((row) => this.toMetadata(row));
  }

  /** The session a workspace folder should resume into, or null when that folder has never been opened. */
  findLatestByWorkspacePath(workspacePath: string): SessionMetadata | null {
    const row = this.database.prepare("SELECT * FROM sessions WHERE workspace_path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(workspacePath) as SessionRow | undefined;
    return row === undefined ? null : this.toMetadata(row);
  }

  /** Idempotent: a session resumed several times keeps the moment it first recorded anything. */
  markStarted(id: SessionId): void {
    this.database.prepare("UPDATE sessions SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").run(new Date().toISOString(), id);
  }

  markEnded(id: SessionId, status: SessionMetadata["status"]): void {
    this.database.prepare("UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  }

  updateProgress(id: SessionId, headSeq: number, durationMs: number, integrity: SessionMetadata["integrity"]): void {
    this.database.prepare("UPDATE sessions SET head_seq = ?, duration_ms = ?, integrity = ? WHERE id = ?").run(headSeq, durationMs, integrity, id);
  }

  close(): void {
    this.database.close();
  }

  private toMetadata(row: SessionRow): SessionMetadata {
    return {
      id: row.id,
      workspacePath: row.workspace_path,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: row.status,
      streamPath: row.stream_path,
      headSeq: row.head_seq,
      durationMs: row.duration_ms,
      providerId: row.provider_id,
      modelId: row.model_id,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
      reasoningTokens: row.reasoning_tokens,
      costUsd: row.cost_usd,
      integrity: row.integrity
    };
  }
}
