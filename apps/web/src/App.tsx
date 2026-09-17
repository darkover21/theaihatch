import Editor from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { AnySesEvent } from "@theaihatch/ses/browser";
import { validateSesEvent } from "@theaihatch/ses/browser";
import { PlaybackEngine, MemoryEventSource, type PlaybackSnapshot } from "@theaihatch/playback";
import { EditorTabs, type EditorTab } from "./features/editor/EditorTabs";
import { Explorer, type ExplorerEntry } from "./features/explorer/Explorer";
import { TerminalPanel, type TerminalEvent } from "./features/terminal/TerminalPanel";
import { RunPanel } from "./features/agent/RunPanel";
import { ProviderSettings, type ProviderSettingsValue } from "./features/providers/ProviderSettings";
import fixtureText from "../../../fixtures/sessions/walking-skeleton/events.jsonl?raw";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const PROVIDER_SETTINGS: ProviderSettingsValue[] = [{ id: "openai", label: "OpenAI", models: [{ id: "gpt-4o-mini", displayName: "gpt-4o-mini" }, { id: "gpt-4o", displayName: "gpt-4o" }], selectedModel: "gpt-4o-mini", configured: false }, { id: "anthropic", label: "Anthropic", models: [{ id: "claude-sonnet-4-5", displayName: "Claude Sonnet" }], selectedModel: "claude-sonnet-4-5", configured: false }];

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

function readFixture(): AnySesEvent[] {
  return fixtureText.trim().split("\n").map((line) => validateSesEvent(JSON.parse(line) as unknown));
}

function languageFor(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

function initialSnapshot(): PlaybackSnapshot {
  return {
    state: { status: "loading", cursor: -1, head: -1, speed: 1, error: null },
    projection: { files: {}, openPaths: [], activePath: null, cursors: {}, selections: {}, scroll: {}, diffMarkers: [], terminal: "" },
    steps: [],
    currentStepId: null,
    stepsBehind: 0
  };
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

function terminalEvents(events: readonly AnySesEvent[]): TerminalEvent[] {
  return events.flatMap((event) => event.type === "terminal_output" ? [{ stream: event.payload.stream, chunk: event.payload.chunk, eof: event.payload.eof, ...(event.payload.exitCode === undefined ? {} : { exitCode: event.payload.exitCode }), ...(event.payload.signal === undefined ? {} : { signal: event.payload.signal }) }] : []);
}

export default function App() {
  const engine = useMemo(() => new PlaybackEngine(new MemoryEventSource(readFixture())), []);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(initialSnapshot());
  const [theme, setTheme] = useState<"dark" | "light">(() => window.localStorage.getItem("theme") === "light" ? "light" : "dark");
  const [workspace, setWorkspace] = useState<WorkspaceHandle | null>(null);
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
  const agentAbort = useRef<AbortController | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const decorationIds = useRef<string[]>([]);
  const activePath = snapshot.projection.activePath ?? snapshot.projection.openPaths[0] ?? "";
  const activeContent = activePath === "" ? "" : snapshot.projection.files[activePath] ?? "";
  const isLocked = snapshot.state.status === "playing" || snapshot.state.status === "seeking" || snapshot.state.status === "at-live-head";

  useEffect(() => {
    const unsubscribe = engine.subscribe(setSnapshot);
    void engine.load();
    return unsubscribe;
  }, [engine]);

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
    if (workspace === null) return;
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const payload = await responseJson(await fetch(`/api/workspaces/${workspace.id}/changes`));
        if (stopped || typeof payload !== "object" || payload === null || !("changes" in payload) || !Array.isArray(payload.changes)) return;
        const changes = payload.changes.filter((value): value is WorkspaceChange => typeof value === "object" && value !== null && "kind" in value && "path" in value && typeof value.path === "string" && (value.kind === "create" || value.kind === "modify" || value.kind === "delete" || value.kind === "rename"));
        for (const change of changes) {
          const tab = workspaceTabs.find((candidate) => candidate.path === change.path);
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
  }, [workspace, workspaceTabs]);

  async function openWorkspace(): Promise<void> {
    try {
      setWorkspaceError(null);
      const opened = await responseJson(await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: workspacePath }) }));
      if (typeof opened !== "object" || opened === null || !("id" in opened) || !("rootName" in opened) || !("canonicalRoot" in opened) || typeof opened.id !== "string" || typeof opened.rootName !== "string" || typeof opened.canonicalRoot !== "string") throw new Error("invalid workspace response");
      const handle = { id: opened.id, rootName: opened.rootName, canonicalRoot: opened.canonicalRoot };
      const entries = await responseJson(await fetch(`/api/workspaces/${handle.id}/tree`));
      const status = await responseJson(await fetch(`/api/workspaces/${handle.id}/git-status`));
      setWorkspace(handle);
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

  async function runAgent(prompt: string): Promise<void> {
    if (workspace === null) return;
    const controller = new AbortController(); agentAbort.current = controller; setAgentRunning(true); setAgentStatus("running");
    try { const response = await fetch("/api/agent/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: workspace.id, prompt, provider: "openai", model: "gpt-4o-mini" }), signal: controller.signal }); const payload = await responseJson(response); if (typeof payload !== "object" || payload === null || !("events" in payload) || !Array.isArray(payload.events)) throw new Error("invalid agent response"); setWorkspaceEvents(parseEvents(payload)); if ("usage" in payload && typeof payload.usage === "object" && payload.usage !== null && "inputTokens" in payload.usage && "outputTokens" in payload.usage && typeof payload.usage.inputTokens === "number" && typeof payload.usage.outputTokens === "number") setAgentUsage({ inputTokens: payload.usage.inputTokens, outputTokens: payload.usage.outputTokens, costUsd: "costUsd" in payload && typeof payload.costUsd === "number" ? payload.costUsd : null }); setAgentStatus("completed"); } catch (error) { if (controller.signal.aborted) setAgentStatus("cancelled"); else setAgentStatus(error instanceof Error ? error.message : String(error)); } finally { agentAbort.current = null; setAgentRunning(false); }
  }

  function cancelAgent(): void { agentAbort.current?.abort(); }

  async function saveProviderSecret(providerId: string, secret: string): Promise<void> { await responseJson(await fetch(`/api/providers/${providerId}/secret`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) })); }
  async function testProvider(providerId: string): Promise<string> { const model = PROVIDER_SETTINGS.find((provider) => provider.id === providerId)?.selectedModel ?? ""; const result = await responseJson(await fetch(`/api/providers/${providerId}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) })); return typeof result === "object" && result !== null && "message" in result && typeof result.message === "string" ? result.message : "connection test complete"; }

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
          <div className="step-section"><div className="panel-heading"><span>STEPS</span><span className="muted">{snapshot.steps.length}</span></div>{snapshot.steps.map((step) => <button className={`step-row ${snapshot.currentStepId === step.id ? "selected" : ""}`} key={step.id} onClick={() => void engine.seek(step.startSeq)}><span className="step-status">{step.outcome === "succeeded" ? "✓" : "•"}</span><span><strong>{step.label}</strong><small>{step.files.join(", ") || "session"}</small></span></button>)}</div>
        </aside>
      ) : (
        <div className="workspace-explorer-shell">
          <div className="workspace-opener"><strong>{workspace.rootName}</strong><button onClick={() => void runDemo()}>Run scripted demo</button><button onClick={() => setWorkspace(null)}>Close</button></div>
          <Explorer rootName={workspace.rootName} entries={workspaceEntries} activePath={workspaceActivePath} decorations={workspaceDecorations} onOpenFile={(path) => void openWorkspaceFile(workspace.id, path, true)} onExpand={async (path) => parseEntries(await responseJson(await fetch(`/api/workspaces/${workspace.id}/tree?${new URLSearchParams({ path }).toString()}`)))} />
          <ProviderSettings providers={PROVIDER_SETTINGS} onSelect={() => undefined} onSaveSecret={saveProviderSecret} onTest={testProvider} />
          <RunPanel running={agentRunning} status={agentStatus} usage={agentUsage} onRun={(prompt) => void runAgent(prompt)} onCancel={cancelAgent} />
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
        ) : (
          <>
            <EditorTabs tabs={workspaceTabs} activePath={workspaceActivePath} theme={theme} readOnly={false} onFocus={setWorkspaceActivePath} onSave={(path) => void saveWorkspaceFile(path)} onClose={(path) => { setWorkspaceTabs((current) => current.filter((tab) => tab.path !== path)); if (workspaceActivePath === path) setWorkspaceActivePath(null); }} onChange={(path, content) => setWorkspaceTabs((current) => current.map((tab) => tab.path === path ? { ...tab, content, dirty: true } : tab))} />
            <TerminalPanel {...(() => { const command = workspaceEvents.find((event) => event.type === "terminal_command"); return command?.type === "terminal_command" ? { command: command.payload.command } : {}; })()} events={terminalEvents(workspaceEvents)} collapsed={terminalCollapsed} height={terminalHeight} onToggle={() => setTerminalCollapsed((collapsed) => !collapsed)} onHeightChange={setTerminalHeight} />
          </>
        )}
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
