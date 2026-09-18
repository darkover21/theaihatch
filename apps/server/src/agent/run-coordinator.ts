import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentRuntime, ReviewGate, type AgentRunResult, type AgentToolResult } from "@theaihatch/agent";
import type { ProviderAdapter, ProviderUsage } from "@theaihatch/providers";
import { DryRunRecorder, GitCheckpointStore, type GitCheckpoint, type ProposedAction } from "@theaihatch/safety";
import { ConversationRepository, ReviewRepository, SafetyAuditRepository, type StoredReviewDecisionInput } from "@theaihatch/storage";
import type { AnySesEvent, SesEventInput } from "@theaihatch/ses";
import { WorkspaceTree } from "@theaihatch/workspace";
import { userPaths } from "@theaihatch/packaging";
import { SesWriter } from "../ses.js";
import { ApprovalBroker, type PendingApproval } from "./approval-broker.js";
import { createGuardedWorkspaceTools } from "./guarded-tools.js";
import { platformToolDefinitions } from "./ses-recorder.js";

export type RunStatus = "running" | "waiting_for_review" | "waiting_for_command" | "completed" | "cancelled" | "failed" | "limit_reached";

export interface RunStatusView {
  runId: string;
  checkpointId: string;
  status: RunStatus;
  events: AnySesEvent[];
  pending: PendingApproval | null;
  proposals: ProposedAction[];
  usage: ProviderUsage;
  error: string | null;
}

export interface StartRunInput {
  tree: WorkspaceTree;
  prompt: string;
  model: string;
  reviewMode: boolean;
  dryRun: boolean;
  createProvider: () => ProviderAdapter | Promise<ProviderAdapter>;
}

export interface RunCoordinatorOptions {
  dataDirectory?: string;
  checkpointStore?: Pick<GitCheckpointStore, "create">;
}

interface RunRecord {
  runId: string;
  conversationId: string;
  checkpoint: GitCheckpoint;
  status: Exclude<RunStatus, "waiting_for_review" | "waiting_for_command">;
  events: AnySesEvent[];
  approvals: ApprovalBroker;
  proposals: DryRunRecorder;
  usage: ProviderUsage;
  error: string | null;
  abortController: AbortController;
  writer: SesWriter;
  conversations: ConversationRepository;
  reviews: ReviewRepository;
  audits: SafetyAuditRepository;
  reviewGate: ReviewGate;
  input: StartRunInput;
  execution: Promise<void>;
}

const zeroUsage = (): ProviderUsage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 });
const terminal = (status: RunStatus): status is Extract<RunStatus, "completed" | "cancelled" | "failed" | "limit_reached"> => status === "completed" || status === "cancelled" || status === "failed" || status === "limit_reached";

export class RunCoordinator {
  private readonly runs = new Map<string, RunRecord>();
  private readonly dataDirectory: string;
  private readonly checkpointStore: Pick<GitCheckpointStore, "create">;

  constructor(options: RunCoordinatorOptions = {}) {
    this.dataDirectory = options.dataDirectory ?? userPaths().data;
    this.checkpointStore = options.checkpointStore ?? new GitCheckpointStore();
  }

  async start(input: StartRunInput): Promise<{ runId: string; checkpointId: string }> {
    const checkpoint = await this.checkpointStore.create(input.tree.root.canonicalPath, "theaihatch agent run checkpoint");
    const provider = await input.createProvider();
    const runId = randomUUID();
    const conversationId = randomUUID();
    let writer: SesWriter | undefined;
    let conversations: ConversationRepository | undefined;
    let reviews: ReviewRepository | undefined;
    let audits: SafetyAuditRepository | undefined;
    try {
      await fs.mkdir(this.dataDirectory, { recursive: true });
      writer = await SesWriter.open(path.join(this.dataDirectory, "agent-runs", runId));
      conversations = new ConversationRepository(path.join(this.dataDirectory, "conversations.sqlite"));
      reviews = new ReviewRepository(this.dataDirectory);
      audits = new SafetyAuditRepository(this.dataDirectory);
      const record: RunRecord = {
        runId,
        conversationId,
        checkpoint,
        status: "running",
        events: [],
        approvals: new ApprovalBroker(),
        proposals: new DryRunRecorder(input.dryRun),
        usage: zeroUsage(),
        error: null,
        abortController: new AbortController(),
        writer,
        conversations,
        reviews,
        audits,
        reviewGate: new ReviewGate(),
        input,
        execution: Promise.resolve()
      };
      conversations.createConversation({ id: conversationId, workspacePath: input.tree.root.canonicalPath, createdAt: new Date().toISOString() });
      conversations.createRun({ id: runId, conversationId, status: "running", startedAt: new Date().toISOString(), endedAt: null, error: null });
      reviews.recordCheckpoint({ runId, checkpointId: checkpoint.id, kind: "run" });
      this.runs.set(runId, record);
      record.execution = this.execute(record, provider);
      void record.execution;
      return { runId, checkpointId: checkpoint.id };
    } catch (error) {
      await closeWriter(writer);
      closeRepository(audits);
      closeRepository(reviews);
      closeRepository(conversations);
      throw error;
    }
  }

  get(runId: string): RunStatusView {
    const record = this.require(runId);
    const pending = record.approvals.pending(runId);
    const status = record.status === "running" && pending !== null ? pending.kind === "review" ? "waiting_for_review" : "waiting_for_command" : record.status;
    return structuredClone({
      runId: record.runId,
      checkpointId: record.checkpoint.id,
      status,
      events: record.events,
      pending,
      proposals: record.proposals.actions,
      usage: record.usage,
      error: record.error
    });
  }

  async resolveReview(runId: string, decisions: readonly StoredReviewDecisionInput[]): Promise<RunStatusView> {
    const record = this.require(runId);
    record.approvals.resolveReview(runId, decisions);
    return this.get(runId);
  }

  async resolveCommand(runId: string, input: { approved: boolean; command: string; cwd: string }): Promise<RunStatusView> {
    const record = this.require(runId);
    record.approvals.resolveCommand(runId, input);
    return this.get(runId);
  }

  cancel(runId: string): void {
    const record = this.require(runId);
    if (terminal(record.status)) return;
    record.approvals.cancel(runId, "run cancelled");
    record.abortController.abort();
  }

  async shutdown(timeoutMs = 5_000): Promise<boolean> {
    const active = [...this.runs.values()].filter((record) => !terminal(record.status));
    for (const record of active) this.cancel(record.runId);
    const drained = Promise.all(active.map((record) => record.execution)).then(() => true, () => false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        drained,
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private require(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (record === undefined) throw new Error(`run not found: ${runId}`);
    return record;
  }

  private async execute(record: RunRecord, provider: ProviderAdapter): Promise<void> {
    let result: AgentRunResult | null = null;
    let outcome: RunRecord["status"] = "failed";
    try {
      const eventWriter = { append: async (event: SesEventInput): Promise<AnySesEvent[]> => this.append(record, event) } as SesWriter;
      const tools = await createGuardedWorkspaceTools({
        operationId: record.runId,
        checkpointId: record.checkpoint.id,
        tree: record.input.tree,
        writer: eventWriter,
        dryRun: record.input.dryRun,
        reviewMode: record.input.reviewMode,
        approvals: record.approvals,
        reviews: record.reviews,
        audits: record.audits,
        reviewGate: record.reviewGate,
        proposals: record.proposals
      });
      const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
      const runtime = new AgentRuntime(provider, {
        model: record.input.model,
        systemPrompt: "You are a local coding agent. Use workspace tools and keep changes reviewable.",
        tools: platformToolDefinitions(),
        reviewGate: record.reviewGate
      });
      result = await runtime.run({
        prompt: record.input.prompt,
        signal: record.abortController.signal,
        executeTool: async (call, signal): Promise<AgentToolResult> => {
          const tool = toolsByName.get(call.name);
          if (tool === undefined) return { ok: false, content: `unknown tool: ${call.name}`, errorCode: "unknown_tool" };
          return tool.execute(call.arguments, signal);
        },
        appendSes: async (event: SesEventInput): Promise<AnySesEvent[]> => this.append(record, event)
      });
      outcome = result.status;
      record.usage = result.usage;
      record.error = result.error;
    } catch (error) {
      outcome = record.abortController.signal.aborted ? "cancelled" : "failed";
      record.error = error instanceof Error ? error.message : String(error);
    }
    const failFinalization = (error: unknown): void => {
      outcome = "failed";
      record.error ??= error instanceof Error ? error.message : String(error);
    };
    try {
      if (result !== null) {
        for (const message of result.messages.filter((candidate) => candidate.role !== "system")) {
          record.conversations.appendMessage({ id: randomUUID(), conversationId: record.conversationId, role: message.role, content: message.content, toolCallId: message.toolCallId ?? null, toolName: message.toolCalls?.[0]?.name ?? null, createdAt: new Date().toISOString() });
        }
        record.conversations.saveUsage(record.runId, { ...result.usage, costUsd: result.costUsd, priceVersion: result.priceVersion });
      } else {
        record.conversations.saveUsage(record.runId, { ...record.usage, costUsd: null, priceVersion: "unpriced" });
      }
    } catch (error) {
      failFinalization(error);
    }
    try { await record.writer.appendCheckpoint("final"); } catch (error) { failFinalization(error); }
    try { await record.writer.close(); } catch (error) { failFinalization(error); }
    try { record.reviews.close(); } catch (error) { failFinalization(error); }
    try { record.audits.close(); } catch (error) { failFinalization(error); }
    try { record.conversations.updateRun(record.runId, outcome, new Date().toISOString(), record.error); } catch (error) { failFinalization(error); }
    try { record.conversations.close(); } catch (error) { failFinalization(error); }
    record.status = outcome;
  }

  private async append(record: RunRecord, event: SesEventInput): Promise<AnySesEvent[]> {
    const appended = await record.writer.append(event);
    record.events.push(...appended);
    return appended;
  }
}

async function closeWriter(writer: SesWriter | undefined): Promise<void> {
  if (writer === undefined) return;
  try { await writer.close(); } catch { /* preserve the startup failure */ }
}

function closeRepository(repository: { close(): void } | undefined): void {
  try { repository?.close(); } catch { /* preserve the startup failure */ }
}
