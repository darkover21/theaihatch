import Editor from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { AnySesEvent } from "@theaihatch/ses/browser";
import { validateSesEvent } from "@theaihatch/ses/browser";
import { EditorTabs, type EditorTab } from "./features/editor/EditorTabs";
import { Explorer, type ExplorerEntry } from "./features/explorer/Explorer";
import { TerminalPanel, type TerminalEvent } from "./features/terminal/TerminalPanel";
import { RunPanel, type AgentRunOptions } from "./features/agent/RunPanel";
import { ReviewPanel, type ReviewHunkView } from "./features/review/ReviewPanel";
import { ProviderSettings, type ProviderSettingsValue } from "./features/providers/ProviderSettings";
import fixtureText from "../../../fixtures/sessions/walking-skeleton/events.jsonl?raw";
import { useLiveSession } from "./features/live/useLiveSession";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const PROVIDER_SETTINGS: ProviderSettingsValue[] = [{ id: "openai", label: "OpenAI", models: [{ id: "gpt-4o-mini", displayName: "gpt-4o-mini" }, { id: "gpt-4o", displayName: "gpt-4o" }], selectedModel: "gpt-4o-mini", configured: false }, { id: "anthropic", label: "Anthropic", models: [{ id: "claude-sonnet-4-5", displayName: "Claude Sonnet" }], selectedModel: "claude-sonnet-4-5", configured: false }, { id: "gemini", label: "Google Gemini", models: [{ id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" }, { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }], selectedModel: "gemini-2.5-flash", configured: false }];

interface WorkspaceHandle {
  id: string;
  rootName: string;
  canonicalRoot: string;
}

interface WorkspaceChange {
  kind: "create" | "modify" | "delete" | "rename";
  path: string;
  previousPath?: string;
}

type AgentRunStatus = "running" | "waiting_for_review" | "waiting_for_command" | "completed" | "cancelled" | "failed" | "limit_reached";

interface AgentReviewHunk {
  id: string;
  path: string;
  startLine: number;
  beforeLines: string[];
  afterLines: string[];
  fingerprint: string;
  eventSeq?: number;
}

interface AgentPendingReview { kind: "review"; operationId: string; snapshotId: string; hunks: AgentReviewHunk[]; }
interface AgentPendingCommand { kind: "command"; operationId: string; decision: { destructive: boolean; reason: string | null; exactCommand: string; cwd: string }; }
type AgentPendingApproval = AgentPendingReview | AgentPendingCommand;

interface AgentProposal { kind: "file" | "command"; description: string; path?: string; command?: string; }
interface AgentRunView { runId: string; checkpointId: string; status: AgentRunStatus; events: AnySesEvent[]; pending: AgentPendingApproval | null; proposals: AgentProposal[]; usage: { inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number }; error: string | null; }
interface AgentReviewDecision { hunkId: string; decision: "accepted" | "rejected"; actor: string; feedback?: string; }

const terminalAgentStatuses = new Set<AgentRunStatus>(["completed", "cancelled", "failed", "limit_reached"]);

function readFixture(): AnySesEvent[] {
  return fixtureText.trim().split("\n").map((line) => validateSesEvent(JSON.parse(line) as unknown));
}

function languageFor(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

async function responseJson(response: Response): Promise<unknown> {
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" ? payload.error : "request failed";
    throw new Error(message);
  }
  return payload;
}

function parseEntries(payload: unknown): ExplorerEntry[] {
  if (typeof payload !== "object" || payload === null || !("entries" in payload) || !Array.isArray(payload.entries)) return [];
  return payload.entries.flatMap((value) => {
    if (typeof value !== "object" || value === null || !("name" in value) || !("path" in value) || !("kind" in value)) return [];
    if (typeof value.name !== "string" || typeof value.path !== "string" || (value.kind !== "file" && value.kind !== "directory")) return [];
    return [{ name: value.name, path: value.path, kind: value.kind }];
  });
}

function parseDecorations(payload: unknown): Record<string, string> {
  if (typeof payload !== "object" || payload === null || !("decorations" in payload) || typeof payload.decorations !== "object" || payload.decorations === null) return {};
  return Object.fromEntries(Object.entries(payload.decorations).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"));
}

function parseEvents(payload: unknown): AnySesEvent[] {
  if (typeof payload !== "object" || payload === null || !("events" in payload) || !Array.isArray(payload.events)) return [];
  return payload.events.map((event) => validateSesEvent(event));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function parseAgentStart(payload: unknown): { runId: string; checkpointId: string } {
  const value = recordValue(payload);
  if (value === null || typeof value.runId !== "string" || typeof value.checkpointId !== "string") throw new Error("invalid agent start response");
  return { runId: value.runId, checkpointId: value.checkpointId };
}

function parseAgentPending(value: unknown): AgentPendingApproval | null {
  if (value === null || value === undefined) return null;
  const pending = recordValue(value);
  if (pending === null || typeof pending.kind !== "string" || typeof pending.operationId !== "string") throw new Error("invalid agent pending approval");
  if (pending.kind === "review") {
    const hunks = Array.isArray(pending.hunks) ? pending.hunks.flatMap((candidate): AgentReviewHunk[] => {
      const hunk = recordValue(candidate);
      if (hunk === null || typeof hunk.id !== "string" || typeof hunk.path !== "string" || typeof hunk.startLine !== "number" || !Array.isArray(hunk.beforeLines) || !Array.isArray(hunk.afterLines) || typeof hunk.fingerprint !== "string") return [];
      if (!hunk.beforeLines.every((line) => typeof line === "string") || !hunk.afterLines.every((line) => typeof line === "string")) return [];
      return [{ id: hunk.id, path: hunk.path, startLine: hunk.startLine, beforeLines: hunk.beforeLines, afterLines: hunk.afterLines, fingerprint: hunk.fingerprint, ...(typeof hunk.eventSeq === "number" ? { eventSeq: hunk.eventSeq } : {}) }];
    }) : [];
    if (typeof pending.snapshotId !== "string" || hunks.length === 0) throw new Error("invalid agent review approval");
    return { kind: "review", operationId: pending.operationId, snapshotId: pending.snapshotId, hunks };
  }
  if (pending.kind === "command") {
    const decision = recordValue(pending.decision);
    if (decision === null || typeof decision.destructive !== "boolean" || (typeof decision.reason !== "string" && decision.reason !== null) || typeof decision.exactCommand !== "string" || typeof decision.cwd !== "string") throw new Error("invalid agent command approval");
    return { kind: "command", operationId: pending.operationId, decision: { destructive: decision.destructive, reason: decision.reason, exactCommand: decision.exactCommand, cwd: decision.cwd } };
  }
  throw new Error("invalid agent pending approval kind");
}

function parseAgentRunView(payload: unknown): AgentRunView {
  const value = recordValue(payload);
  const statuses: AgentRunStatus[] = ["running", "waiting_for_review", "waiting_for_command", "completed", "cancelled", "failed", "limit_reached"];
  const usage = value === null ? null : recordValue(value.usage);
  if (value === null || typeof value.runId !== "string" || typeof value.checkpointId !== "string" || typeof value.status !== "string" || !statuses.includes(value.status as AgentRunStatus) || usage === null || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number" || typeof usage.cachedTokens !== "number" || typeof usage.reasoningTokens !== "number") throw new Error("invalid agent status response");
  const proposals = Array.isArray(value.proposals) ? value.proposals.flatMap((candidate): AgentProposal[] => {
    const proposal = recordValue(candidate);
    if (proposal === null || (proposal.kind !== "file" && proposal.kind !== "command") || typeof proposal.description !== "string") return [];
    return [{ kind: proposal.kind, description: proposal.description, ...(typeof proposal.path === "string" ? { path: proposal.path } : {}), ...(typeof proposal.command === "string" ? { command: proposal.command } : {}) }];
  }) : [];
  return { runId: value.runId, checkpointId: value.checkpointId, status: value.status as AgentRunStatus, events: parseEvents(payload), pending: parseAgentPending(value.pending), proposals, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, reasoningTokens: usage.reasoningTokens }, error: typeof value.error === "string" ? value.error : null };
}

function terminalEvents(events: readonly AnySesEvent[]): TerminalEvent[] {
  return events.flatMap((event) => event.type === "terminal_output" ? [{ stream: event.payload.stream, chunk: event.payload.chunk, eof: event.payload.eof, ...(event.payload.exitCode === undefined ? {} : { exitCode: event.payload.exitCode }), ...(event.payload.signal === undefined ? {} : { signal: event.payload.signal }) }] : []);
}

export default function App() {
  const fixture = useMemo(readFixture, []);
  const [theme, setTheme] = useState<"dark" | "light">(() => window.localStorage.getItem("theme") === "light" ? "light" : "dark");
  const [workspace, setWorkspace] = useState<WorkspaceHandle | null>(null);
  const [sessionMode, setSessionMode] = useState<"watch" | "edit">("watch");
  const { engine, snapshot } = useLiveSession(workspace?.id ?? null, fixture);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceEntries, setWorkspaceEntries] = useState<ExplorerEntry[]>([]);
  const [workspaceDecorations, setWorkspaceDecorations] = useState<Record<string, string>>({});
  const [workspaceTabs, setWorkspaceTabs] = useState<EditorTab[]>([]);
  const [workspaceActivePath, setWorkspaceActivePath] = useState<string | null>(null);
  const [workspaceEvents, setWorkspaceEvents] = useState<AnySesEvent[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(180);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentStatus, setAgentStatus] = useState("idle");
  const [agentUsage, setAgentUsage] = useState({ inputTokens: 0, outputTokens: 0, costUsd: null as number | null });
  const [agentRun, setAgentRun] = useState<AgentRunView | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, AgentReviewDecision>>({});
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsValue[]>(PROVIDER_SETTINGS);
  const [selectedProviderId, setSelectedProviderId] = useState("openai");
  const agentAbort = useRef<AbortController | null>(null);
  const agentRunId = useRef<string | null>(null);
  const workspaceTabsRef = useRef<EditorTab[]>([]);
  const changeCursor = useRef(0);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const decorationIds = useRef<string[]>([]);
  const activePath = snapshot.projection.activePath ?? snapshot.projection.openPaths[0] ?? "";
  const activeContent = activePath === "" ? "" : snapshot.projection.files[activePath] ?? "";
  const isLocked = snapshot.state.status === "playing" || snapshot.state.status === "seeking" || snapshot.state.status === "at-live-head";

  useEffect(() => () => { agentAbort.current?.abort(); }, []);

  useEffect(() => {
    window.localStorage.setItem("theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (editor === null || monaco === null) return;
    decorationIds.current = editor.deltaDecorations(decorationIds.current, snapshot.projection.diffMarkers
      .filter((marker) => marker.path === activePath)
      .map((marker) => ({
        range: new monaco.Range(marker.range.start.line + 1, marker.range.start.column + 1, marker.range.end.line + 1, Math.max(marker.range.end.column + 1, marker.range.start.column + 2)),
        options: { isWholeLine: true, linesDecorationsClassName: `ses-diff-${marker.kind}` }
      })));
  }, [activePath, snapshot.projection.diffMarkers]);

  async function openWorkspaceFile(id: string, path: string, focus: boolean): Promise<void> {
    const query = new URLSearchParams({ path });
    const payload = await responseJson(await fetch(`/api/workspaces/${id}/file?${query.toString()}`));
    if (typeof payload !== "object" || payload === null || !("path" in payload) || !("content" in payload) || typeof payload.path !== "string" || typeof payload.content !== "string") throw new Error("invalid file response");
    const filePath = payload.path;
    const fileContent = payload.content;
    setWorkspaceTabs((current) => current.some((tab) => tab.path === filePath) ? current.map((tab) => tab.path === filePath ? { ...tab, content: fileContent, dirty: false } : tab) : [...current, { path: filePath, content: fileContent }]);
    if (focus) setWorkspaceActivePath(filePath);
  }

  useEffect(() => {
    workspaceTabsRef.current = workspaceTabs;
  }, [workspaceTabs]);

  useEffect(() => {
    changeCursor.current = 0;
  }, [workspace]);

  useEffect(() => {
    if (workspace === null || sessionMode !== "edit") return;
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const payload = await responseJson(await fetch(`/api/workspaces/${workspace.id}/changes?since=${changeCursor.current}`));
        if (stopped || typeof payload !== "object" || payload === null || !("changes" in payload) || !Array.isArray(payload.changes)) return;
        if ("cursor" in payload && typeof payload.cursor === "number") changeCursor.current = payload.cursor;
        const changes = payload.changes.filter((value): value is WorkspaceChange => typeof value === "object" && value !== null && "kind" in value && "path" in value && typeof value.path === "string" && (value.kind === "create" || value.kind === "modify" || value.kind === "delete" || value.kind === "rename"));
        for (const change of changes) {
          const tab = workspaceTabsRef.current.find((candidate) => candidate.path === change.path);
          if (tab?.dirty === true) setConflictPath(change.path);
          else if (tab !== undefined && change.kind !== "delete") await openWorkspaceFile(workspace.id, change.path, false);
          else if (tab !== undefined) setWorkspaceTabs((current) => current.filter((candidate) => candidate.path !== change.path));
        }
      } catch {
        // The workspace may be closing; the next poll retries without interrupting playback.
      }
    };
    const timer = window.setInterval(() => void poll(), 700);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [workspace, sessionMode]);

  async function openWorkspace(): Promise<void> {
    try {
      setWorkspaceError(null);
      const opened = await responseJson(await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: workspacePath }) }));
      if (typeof opened !== "object" || opened === null || !("id" in opened) || !("rootName" in opened) || !("canonicalRoot" in opened) || typeof opened.id !== "string" || typeof opened.rootName !== "string" || typeof opened.canonicalRoot !== "string") throw new Error("invalid workspace response");
      const handle = { id: opened.id, rootName: opened.rootName, canonicalRoot: opened.canonicalRoot };
      const entries = await responseJson(await fetch(`/api/workspaces/${handle.id}/tree`));
      const status = await responseJson(await fetch(`/api/workspaces/${handle.id}/git-status`));
      setWorkspace(handle);
      setSessionMode("watch");
      setWorkspaceEntries(parseEntries(entries));
      setWorkspaceDecorations(parseDecorations(status));
      setWorkspaceTabs([]);
      setWorkspaceActivePath(null);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }

  async function runDemo(): Promise<void> {
    if (workspace === null) return;
    try {
      setWorkspaceError(null);
      const payload = await responseJson(await fetch(`/api/workspaces/${workspace.id}/demo`, { method: "POST" }));
      const events = parseEvents(payload);
      setWorkspaceEvents(events);
      if (typeof payload === "object" && payload !== null && "path" in payload && typeof payload.path === "string") await openWorkspaceFile(workspace.id, payload.path, true);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveWorkspaceFile(path: string): Promise<void> {
    if (workspace === null) return;
    const tab = workspaceTabs.find((candidate) => candidate.path === path);
    if (tab === undefined) return;
    try {
      setWorkspaceError(null);
      await responseJson(await fetch(`/api/workspaces/${workspace.id}/file`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, content: tab.content }) }));
      setWorkspaceTabs((current) => current.map((candidate) => candidate.path === path ? { ...candidate, dirty: false } : candidate));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }

  async function reloadConflict(): Promise<void> {
    if (workspace === null || conflictPath === null) return;
    await openWorkspaceFile(workspace.id, conflictPath, true);
    setConflictPath(null);
  }

  function applyAgentView(view: AgentRunView): void {
    setAgentRun(view);
    setWorkspaceEvents(view.events);
    setAgentUsage({ inputTokens: view.usage.inputTokens, outputTokens: view.usage.outputTokens, costUsd: null });
    setAgentStatus(view.status);
  }

  async function pollAgentRun(runId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const view = parseAgentRunView(await responseJson(await fetch(`/api/agent/runs/${runId}`, { signal })));
      applyAgentView(view);
      if (terminalAgentStatuses.has(view.status)) return;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
    }
  }

  async function runAgent(options: AgentRunOptions): Promise<void> {
    if (workspace === null || agentAbort.current !== null) return;
    const selectedProvider = providerSettings.find((provider) => provider.id === selectedProviderId) ?? providerSettings[0];
    if (selectedProvider === undefined) return;
    const controller = new AbortController();
    agentAbort.current = controller;
    agentRunId.current = null;
    setAgentRun(null);
    setReviewDecisions({});
    setWorkspaceEvents([]);
    setAgentRunning(true);
    setAgentStatus("starting");
    try {
      const started = parseAgentStart(await responseJson(await fetch("/api/agent/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id, prompt: options.prompt, provider: selectedProvider.id, model: selectedProvider.selectedModel, reviewMode: options.reviewMode, dryRun: options.dryRun }), signal: controller.signal })));
      agentRunId.current = started.runId;
      await pollAgentRun(started.runId, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) setAgentStatus("cancelled");
      else setAgentStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (agentAbort.current === controller) agentAbort.current = null;
      setAgentRunning(false);
    }
  }

  function cancelAgent(): void {
    const runId = agentRunId.current;
    if (runId === null) {
      agentAbort.current?.abort();
      return;
    }
    setAgentStatus("cancelling");
    void fetch(`/api/agent/runs/${runId}/cancel`, { method: "POST" }).then(responseJson).then((payload) => applyAgentView(parseAgentRunView(payload))).catch((error: unknown) => setAgentStatus(error instanceof Error ? error.message : String(error)));
  }

  async function submitReviewDecisions(decisions: readonly AgentReviewDecision[]): Promise<void> {
    const runId = agentRunId.current;
    if (runId === null) return;
    try {
      const payload = await responseJson(await fetch(`/api/agent/runs/${runId}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions }) }));
      setReviewDecisions({});
      applyAgentView(parseAgentRunView(payload));
    } catch (error) {
      setAgentStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function chooseReviewDecision(hunk: ReviewHunkView, decision: "accepted" | "rejected", feedback?: string): void {
    const next: Record<string, AgentReviewDecision> = { ...reviewDecisions, [hunk.id]: { hunkId: hunk.id, decision, actor: "user", ...(feedback === undefined || feedback.trim() === "" ? {} : { feedback: feedback.trim() }) } };
    setReviewDecisions(next);
    const pending = agentRun?.pending;
    if (pending?.kind === "review" && pending.hunks.every((candidate) => next[candidate.id] !== undefined)) void submitReviewDecisions(Object.values(next));
  }

  function acceptAllReview(): void {
    const pending = agentRun?.pending;
    if (pending?.kind !== "review") return;
    const decisions = pending.hunks.map((hunk): AgentReviewDecision => ({ hunkId: hunk.id, decision: "accepted", actor: "user" }));
    setReviewDecisions(Object.fromEntries(decisions.map((decision) => [decision.hunkId, decision])));
    void submitReviewDecisions(decisions);
  }

  function seekAgentEvent(seq: number): void {
    setAgentStatus(`review event ${seq}`);
  }

  function agentReviewHunks(): ReviewHunkView[] {
    const pending = agentRun?.pending;
    if (pending?.kind !== "review") return [];
    return pending.hunks.map((hunk) => {
      const selected = reviewDecisions[hunk.id];
      return { id: hunk.id, path: hunk.path, before: hunk.beforeLines.join("\n"), after: hunk.afterLines.join("\n"), ...(hunk.eventSeq === undefined ? {} : { eventSeq: hunk.eventSeq }), ...(selected === undefined ? {} : { decision: selected.decision, ...(selected.feedback === undefined ? {} : { feedback: selected.feedback }) }) };
    });
  }

  function approveAgentCommand(approved: boolean): void {
    const runId = agentRunId.current;
    const pending = agentRun?.pending;
    if (runId === null || pending?.kind !== "command") return;
    void fetch(`/api/agent/runs/${runId}/command-approval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved, command: pending.decision.exactCommand, cwd: pending.decision.cwd }) }).then(responseJson).then((payload) => applyAgentView(parseAgentRunView(payload))).catch((error: unknown) => setAgentStatus(error instanceof Error ? error.message : String(error)));
  }

  async function saveProviderSecret(providerId: string, secret: string): Promise<void> { await responseJson(await fetch(`/api/providers/${providerId}/secret`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) })); setProviderSettings((providers) => providers.map((provider) => provider.id === providerId ? { ...provider, configured: true } : provider)); }
  async function testProvider(providerId: string): Promise<string> { const model = providerSettings.find((provider) => provider.id === providerId)?.selectedModel ?? ""; const result = await responseJson(await fetch(`/api/providers/${providerId}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) })); return typeof result === "object" && result !== null && "message" in result && typeof result.message === "string" ? result.message : "connection test complete"; }

  // Shared by both shells: a live workspace has steps to show just as a fixture replay does, and before
  // this it only ever rendered in fixture mode, so the provider panel sat where the step list belonged.
  const stepsPanel = (
    <div className="step-section">
      <div className="panel-heading"><span>STEPS</span><span className="muted">{snapshot.steps.length}</span></div>
      {snapshot.steps.length === 0
        ? <p className="step-empty">No steps yet.</p>
        : snapshot.steps.map((step) => <button className={`step-row ${snapshot.currentStepId === step.id ? "selected" : ""}`} key={step.id} onClick={() => void engine.seek(step.startSeq)}><span className="step-status">{step.outcome === "succeeded" ? "✓" : "•"}</span><span><strong>{step.label}</strong><small>{step.files.join(", ") || "session"}</small></span></button>)}
    </div>
  );

  return (
    <main className="app-shell">
      <nav className="activity-bar" aria-label="Activity bar">
        <button className="activity-button active" aria-label="Explorer">▤</button>
        <button className="activity-button" aria-label="Search">⌕</button>
        <button className="activity-button" aria-label="Source control">⑂</button>
        <div className="activity-spacer" />
        <button className="activity-button" aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>◐</button>
      </nav>

      {workspace === null ? (
        <aside className="explorer-panel" aria-label="Explorer">
          <div className="panel-heading"><span>EXPLORER</span><span className="muted">WALKING-SKELETON</span></div>
          <div className="workspace-opener"><label htmlFor="workspace-path">Open local folder</label><input id="workspace-path" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="/path/to/project" /><button onClick={() => void openWorkspace()}>Open</button></div>
          <div className="tree-root">▾ <span>WALKING-SKELETON</span></div>
          {Object.keys(snapshot.projection.files).sort().map((path) => <button className={`tree-file ${activePath === path ? "selected" : ""}`} key={path} onClick={() => void engine.seekFile(path)}><span>{path.endsWith(".ts") ? "♨" : "▤"}</span> {path}</button>)}
          {stepsPanel}
        </aside>
      ) : (
        <div className="workspace-explorer-shell">
          <div className="workspace-opener"><strong>{workspace.rootName}</strong><button onClick={() => void runDemo()}>Run scripted demo</button><button onClick={() => setSessionMode(sessionMode === "watch" ? "edit" : "watch")}>{sessionMode === "watch" ? "Take over" : "Watch"}</button><button onClick={() => { setWorkspace(null); setSessionMode("watch"); }}>Close</button></div>
          <Explorer rootName={workspace.rootName} entries={workspaceEntries} activePath={sessionMode === "watch" ? activePath : workspaceActivePath} decorations={workspaceDecorations} onOpenFile={(path) => sessionMode === "watch" ? void engine.seekFile(path) : void openWorkspaceFile(workspace.id, path, true)} onExpand={async (path) => parseEntries(await responseJson(await fetch(`/api/workspaces/${workspace.id}/tree?${new URLSearchParams({ path }).toString()}`)))} />
          {stepsPanel}
          <ProviderSettings providers={providerSettings} onSelect={(providerId, modelId) => { setSelectedProviderId(providerId); setProviderSettings((providers) => providers.map((provider) => provider.id === providerId ? { ...provider, selectedModel: modelId } : provider)); }} onSaveSecret={saveProviderSecret} onTest={testProvider} />
          <RunPanel running={agentRunning} status={agentStatus} usage={agentUsage} onRun={(options) => void runAgent(options)} onCancel={cancelAgent} />
          {agentRun !== null && <div className="checkpoint-readout">checkpoint: {agentRun.checkpointId}</div>}
          {agentRun !== null && agentRun.proposals.length > 0 && <section aria-label="Dry-run proposals" className="settings-panel proposal-panel"><h2>Dry-run proposals</h2>{agentRun.proposals.map((proposal, index) => <article key={`${proposal.kind}-${index}`}><strong>{proposal.kind === "file" ? proposal.path ?? "file change" : proposal.command ?? "command"}</strong><small>{proposal.description}</small></article>)}</section>}
          {agentRun?.pending?.kind === "review" && <ReviewPanel hunks={agentReviewHunks()} onDecision={chooseReviewDecision} onAcceptAll={acceptAllReview} onSeek={seekAgentEvent} />}
          {agentRun?.pending?.kind === "command" && <section aria-label="Command approval" className="settings-panel command-approval"><h2>Approve command</h2><pre>{agentRun.pending.decision.exactCommand}</pre><small>cwd: {agentRun.pending.decision.cwd}</small>{agentRun.pending.decision.reason !== null && <p>{agentRun.pending.decision.reason}</p>}<div className="review-actions"><button onClick={() => approveAgentCommand(true)}>Approve</button><button onClick={() => approveAgentCommand(false)}>Deny</button></div></section>}
          {workspaceError !== null && <div className="error-box" role="alert">{workspaceError}</div>}
        </div>
      )}

      <section className="workspace" aria-label="Editor workspace">
        {workspace === null ? (
          <>
            <header className="tab-strip" aria-label="Open files">{snapshot.projection.openPaths.map((path) => <button className={`editor-tab ${activePath === path ? "active" : ""}`} key={path} onClick={() => void engine.seekFile(path)}>{path.split("/").at(-1)} <span className="tab-close" aria-hidden="true">×</span></button>)}<span className="tab-spacer" /><span className="lock-indicator">{isLocked ? "🔒 playback" : "replay"}</span></header>
            <div className="editor-wrap" data-testid="monaco-surface">{activePath === "" ? <div className="empty-editor">Press play to open the fixture.</div> : <Editor path={activePath} language={languageFor(activePath)} value={activeContent} theme={theme === "dark" ? "vs-dark" : "light"} onMount={(editor, monaco) => { editorRef.current = editor; monacoRef.current = monaco; }} options={{ readOnly: true, minimap: { enabled: true }, lineNumbers: "on", renderLineHighlight: "all", automaticLayout: true, padding: { top: 14 } }} />}</div>
            <section className="bottom-panel" aria-label="Playback details"><div className="bottom-heading"><span>OUTPUT</span><span className="muted">Fixture session · no provider configured</span></div><pre>{snapshot.projection.terminal || "No terminal events in this walking skeleton."}</pre></section>
          </>
        ) : <>
          {sessionMode === "watch" ? <><header className="tab-strip" aria-label="Open files">{snapshot.projection.openPaths.map((path) => <button className={`editor-tab ${activePath === path ? "active" : ""}`} key={path} onClick={() => void engine.seekFile(path)}>{path.split("/").at(-1)}</button>)}<span className="tab-spacer" /><span className="lock-indicator">🔒 watch</span></header><div className="editor-wrap" data-testid="monaco-surface">{activePath === "" ? <div className="empty-editor">Waiting for workspace events.</div> : <Editor path={activePath} language={languageFor(activePath)} value={activeContent} theme={theme === "dark" ? "vs-dark" : "light"} options={{ readOnly: true, minimap: { enabled: true }, automaticLayout: true, padding: { top: 14 } }} />}</div><section className="bottom-panel" aria-label="Playback details"><pre>{snapshot.projection.terminal}</pre></section></> : <><EditorTabs tabs={workspaceTabs} activePath={workspaceActivePath} theme={theme} readOnly={false} onFocus={setWorkspaceActivePath} onSave={(path) => void saveWorkspaceFile(path)} onClose={(path) => { setWorkspaceTabs((current) => current.filter((tab) => tab.path !== path)); if (workspaceActivePath === path) setWorkspaceActivePath(null); }} onChange={(path, content) => setWorkspaceTabs((current) => current.map((tab) => tab.path === path ? { ...tab, content, dirty: true } : tab))} /><TerminalPanel {...(() => { const command = workspaceEvents.find((event) => event.type === "terminal_command"); return command?.type === "terminal_command" ? { command: command.payload.command } : {}; })()} events={terminalEvents(workspaceEvents)} collapsed={terminalCollapsed} height={terminalHeight} onToggle={() => setTerminalCollapsed((collapsed) => !collapsed)} onHeightChange={setTerminalHeight} /></>}
        </>}
        <footer className="status-bar"><span>{workspace === null ? snapshot.state.status : "workspace"}</span><span>Ln {workspace === null ? (activePath === "" ? 1 : (snapshot.projection.cursors[activePath]?.line ?? 0) + 1) : 1}, Col {workspace === null ? (activePath === "" ? 1 : (snapshot.projection.cursors[activePath]?.column ?? 0) + 1) : 1}</span><span className="status-grow" /><span>UTF-8</span><span>{workspace === null ? "TypeScript" : "Local project"}</span></footer>
      </section>

      <section className="transport" aria-label="Transport controls">
        <div className="transport-title"><span>SESSION REPLAY</span><span className="head-label">{snapshot.state.cursor + 1} / {snapshot.state.head + 1}</span></div>
        <div className="transport-row"><button data-testid="event-back" title="Previous event" onClick={() => void engine.stepEventBackward()}>◀│</button><button data-testid="step-back" title="Previous step" onClick={() => void engine.stepBackward()}>◀</button><button data-testid="play-pause" className="primary-control" onClick={() => snapshot.state.status === "playing" ? engine.pause() : void engine.play()}>{snapshot.state.status === "playing" ? "Ⅱ" : "▶"}</button><button data-testid="step-forward" title="Next step" onClick={() => void engine.stepForward()}>▶</button><button data-testid="event-forward" title="Next event" onClick={() => void engine.stepEventForward()}>│▶</button></div>
        <div className="seek-row"><label htmlFor="timeline">Timeline</label><input id="timeline" data-testid="timeline" type="range" min={-1} max={Math.max(-1, snapshot.state.head)} value={snapshot.state.cursor} onChange={(event) => void engine.seek(Number(event.target.value))} /></div>
        <div className="transport-row secondary"><label htmlFor="speed">Speed</label><select id="speed" value={snapshot.state.speed} onChange={(event) => engine.setSpeed(Number(event.target.value))}>{SPEEDS.map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select><button data-testid="jump-live" onClick={() => void engine.jumpToLive()}>Jump to live</button></div>
        <div className="live-readout">{snapshot.stepsBehind > 0 ? <><span className="live-dot" />{snapshot.stepsBehind} {snapshot.stepsBehind === 1 ? "step" : "steps"} behind</> : snapshot.state.status === "ended" ? "End of fixture" : "At live head"}</div>
        {snapshot.state.error !== null && <div className="error-box" role="alert">{snapshot.state.error}</div>}
        {conflictPath !== null && <div className="error-box" role="alert">{conflictPath} changed outside the editor. <button onClick={() => void reloadConflict()}>Reload</button></div>}
      </section>
    </main>
  );
}
