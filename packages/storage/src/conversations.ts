import Database from "better-sqlite3";

export type ConversationMessageRole = "system" | "user" | "assistant" | "tool";

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: ConversationMessageRole;
  content: string;
  toolCallId: string | null;
  toolName: string | null;
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  workspacePath: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  status: "running" | "completed" | "cancelled" | "failed" | "limit_reached";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  priceVersion: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: ConversationMessageRole;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  created_at: string;
}

export class ConversationRepository {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS run_usage (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        price_version TEXT NOT NULL
      );
    `);
  }

  createConversation(input: ConversationRecord): ConversationRecord {
    this.database.prepare("INSERT INTO conversations (id, workspace_path, created_at) VALUES (?, ?, ?)").run(input.id, input.workspacePath, input.createdAt);
    return input;
  }

  getConversation(id: string): ConversationRecord {
    const row = this.database.prepare("SELECT id, workspace_path AS workspacePath, created_at AS createdAt FROM conversations WHERE id = ?").get(id) as ConversationRecord | undefined;
    if (row === undefined) throw new Error(`conversation not found: ${id}`);
    return row;
  }

  appendMessage(message: ConversationMessage): void {
    this.database.prepare(`INSERT INTO conversation_messages (id, conversation_id, role, content, tool_call_id, tool_name, created_at) VALUES (@id, @conversationId, @role, @content, @toolCallId, @toolName, @createdAt)`).run({
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      createdAt: message.createdAt
    });
  }

  listMessages(conversationId: string): ConversationMessage[] {
    const rows = this.database.prepare("SELECT id, conversation_id, role, content, tool_call_id, tool_name, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY rowid ASC").all(conversationId) as MessageRow[];
    return rows.map((row) => ({ id: row.id, conversationId: row.conversation_id, role: row.role, content: row.content, toolCallId: row.tool_call_id, toolName: row.tool_name, createdAt: row.created_at }));
  }

  createRun(run: RunRecord): void {
    this.database.prepare("INSERT INTO agent_runs (id, conversation_id, status, started_at, ended_at, error) VALUES (@id, @conversationId, @status, @startedAt, @endedAt, @error)").run(run);
  }

  updateRun(id: string, status: RunRecord["status"], endedAt: string | null, error: string | null): void {
    this.database.prepare("UPDATE agent_runs SET status = ?, ended_at = ?, error = ? WHERE id = ?").run(status, endedAt, error, id);
  }

  getRun(id: string): RunRecord {
    const row = this.database.prepare("SELECT id, conversation_id AS conversationId, status, started_at AS startedAt, ended_at AS endedAt, error FROM agent_runs WHERE id = ?").get(id) as RunRecord | undefined;
    if (row === undefined) throw new Error(`run not found: ${id}`);
    return row;
  }

  saveUsage(runId: string, usage: UsageRecord): void {
    this.database.prepare(`INSERT INTO run_usage (run_id, input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost_usd, price_version) VALUES (@runId, @inputTokens, @outputTokens, @cachedTokens, @reasoningTokens, @costUsd, @priceVersion) ON CONFLICT(run_id) DO UPDATE SET input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cached_tokens = excluded.cached_tokens, reasoning_tokens = excluded.reasoning_tokens, cost_usd = excluded.cost_usd, price_version = excluded.price_version`).run({ runId, ...usage });
  }

  getUsage(runId: string): UsageRecord {
    const row = this.database.prepare("SELECT input_tokens AS inputTokens, output_tokens AS outputTokens, cached_tokens AS cachedTokens, reasoning_tokens AS reasoningTokens, cost_usd AS costUsd, price_version AS priceVersion FROM run_usage WHERE run_id = ?").get(runId) as UsageRecord | undefined;
    if (row === undefined) throw new Error(`usage not found for run: ${runId}`);
    return row;
  }

  close(): void {
    this.database.close();
  }
}
