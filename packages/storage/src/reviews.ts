import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FileDiff } from "@theaihatch/review";

export interface StoredReviewDecision {
  hunkId: string;
  decision: "accepted" | "rejected";
  actor: string;
  timestamp: string;
  feedback?: string;
}

export type StoredReviewDecisionInput = Omit<StoredReviewDecision, "timestamp"> & { timestamp?: string };

export interface StoredReviewSnapshot {
  id: string;
  runId: string;
  checkpointId: string;
  createdAt: string;
  files: FileDiff[];
  decisions: StoredReviewDecision[];
}

interface SnapshotRow { id: string; run_id: string; checkpoint_id: string; created_at: string; files: string; }
interface DecisionRow { hunk_id: string; decision: StoredReviewDecision["decision"]; actor: string; timestamp: string; feedback: string | null; }

export class ReviewRepository {
  private readonly database: Database.Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.database = new Database(path.resolve(dataDir, "sessions.sqlite"));
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS review_snapshots (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        files TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL REFERENCES review_snapshots(id),
        hunk_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        feedback TEXT
      );
      CREATE TABLE IF NOT EXISTS review_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createSnapshot(input: Omit<StoredReviewSnapshot, "id" | "createdAt" | "decisions">): StoredReviewSnapshot {
    const snapshot: StoredReviewSnapshot = { id: randomUUID(), runId: input.runId, checkpointId: input.checkpointId, createdAt: new Date().toISOString(), files: clone(input.files), decisions: [] };
    this.database.prepare("INSERT INTO review_snapshots (id, run_id, checkpoint_id, created_at, files) VALUES (@id, @runId, @checkpointId, @createdAt, @files)").run({ ...snapshot, files: JSON.stringify(snapshot.files) });
    return clone(snapshot);
  }

  resolveSnapshot(id: string, decisions: readonly StoredReviewDecisionInput[]): StoredReviewSnapshot {
    this.getSnapshot(id);
    const insert = this.database.prepare("INSERT INTO review_decisions (snapshot_id, hunk_id, decision, actor, timestamp, feedback) VALUES (@snapshotId, @hunkId, @decision, @actor, @timestamp, @feedback)");
    const timestamp = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      for (const decision of decisions) insert.run({ snapshotId: id, hunkId: decision.hunkId, decision: decision.decision, actor: decision.actor, timestamp: decision.timestamp ?? timestamp, feedback: decision.feedback ?? null });
    });
    transaction();
    return this.getSnapshot(id);
  }

  listSnapshots(runId: string): StoredReviewSnapshot[] {
    const rows = this.database.prepare("SELECT id, run_id, checkpoint_id, created_at, files FROM review_snapshots WHERE run_id = ? ORDER BY created_at ASC, rowid ASC").all(runId) as SnapshotRow[];
    return rows.map((row) => this.toSnapshot(row));
  }

  recordCheckpoint(input: { runId: string; checkpointId: string; kind: "run" | "recovery" | "revert"; createdAt?: string }): void {
    this.database.prepare("INSERT INTO review_checkpoints (run_id, checkpoint_id, kind, created_at) VALUES (@runId, @checkpointId, @kind, @createdAt)").run({ ...input, createdAt: input.createdAt ?? new Date().toISOString() });
  }

  close(): void { this.database.close(); }

  private getSnapshot(id: string): StoredReviewSnapshot {
    const row = this.database.prepare("SELECT id, run_id, checkpoint_id, created_at, files FROM review_snapshots WHERE id = ?").get(id) as SnapshotRow | undefined;
    if (row === undefined) throw new Error(`review snapshot not found: ${id}`);
    return this.toSnapshot(row);
  }

  private toSnapshot(row: SnapshotRow): StoredReviewSnapshot {
    const decisions = this.database.prepare("SELECT hunk_id, decision, actor, timestamp, feedback FROM review_decisions WHERE snapshot_id = ? ORDER BY id ASC").all(row.id) as DecisionRow[];
    return clone({ id: row.id, runId: row.run_id, checkpointId: row.checkpoint_id, createdAt: row.created_at, files: JSON.parse(row.files) as FileDiff[], decisions: decisions.map((decision) => ({ hunkId: decision.hunk_id, decision: decision.decision, actor: decision.actor, timestamp: decision.timestamp, ...(decision.feedback === null ? {} : { feedback: decision.feedback }) })) });
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
