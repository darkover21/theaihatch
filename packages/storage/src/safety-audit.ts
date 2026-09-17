import Database from "better-sqlite3";
import path from "node:path";

export interface SafetyAuditRecord { id?: number; runId: string; action: string; decision: "approved" | "denied" | "recorded" | "suppressed"; detail: string; createdAt?: string; }
interface AuditRow { id: number; run_id: string; action: string; decision: SafetyAuditRecord["decision"]; detail: string; created_at: string; }
export class SafetyAuditRepository {
  private readonly database: Database.Database;
  constructor(dataDir: string) { this.database = new Database(path.resolve(dataDir, "sessions.sqlite")); this.database.exec("CREATE TABLE IF NOT EXISTS safety_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, action TEXT NOT NULL, decision TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL)"); }
  record(record: SafetyAuditRecord): SafetyAuditRecord { const createdAt = record.createdAt ?? new Date().toISOString(); const result = this.database.prepare("INSERT INTO safety_audit (run_id, action, decision, detail, created_at) VALUES (?, ?, ?, ?, ?)").run(record.runId, record.action, record.decision, record.detail, createdAt); return { ...record, id: Number(result.lastInsertRowid), createdAt }; }
  list(runId?: string): SafetyAuditRecord[] { const rows = (runId === undefined ? this.database.prepare("SELECT * FROM safety_audit ORDER BY id").all() : this.database.prepare("SELECT * FROM safety_audit WHERE run_id = ? ORDER BY id").all(runId)) as AuditRow[]; return rows.map((row) => ({ id: row.id, runId: row.run_id, action: row.action, decision: row.decision, detail: row.detail, createdAt: row.created_at })); }
  close(): void { this.database.close(); }
}
