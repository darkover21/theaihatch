import Editor from "@monaco-editor/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { AnySesEvent } from "@theaihatch/ses/browser";
import { validateSesEvent } from "@theaihatch/ses/browser";
import { PlaybackEngine, MemoryEventSource, type PlaybackSnapshot } from "@theaihatch/playback";
import fixtureText from "../../../fixtures/sessions/walking-skeleton/events.jsonl?raw";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];

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

export default function App() {
  const engine = useMemo(() => new PlaybackEngine(new MemoryEventSource(readFixture())), []);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(initialSnapshot);
  const [theme, setTheme] = useState<"dark" | "light">(() => window.localStorage.getItem("theme") === "light" ? "light" : "dark");
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

  return (
    <main className="app-shell">
      <span className="hidden" aria-hidden="true" />
      <nav className="activity-bar" aria-label="Activity bar">
        <button className="activity-button active" aria-label="Explorer">▤</button>
        <button className="activity-button" aria-label="Search">⌕</button>
        <button className="activity-button" aria-label="Source control">⑂</button>
        <div className="activity-spacer" />
        <button className="activity-button" aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>◐</button>
      </nav>

      <aside className="explorer-panel" aria-label="Explorer">
        <div className="panel-heading"><span>EXPLORER</span><span className="muted">WALKING-SKELETON</span></div>
        <div className="tree-root">⌄ <span>WALKING-SKELETON</span></div>
        {Object.keys(snapshot.projection.files).sort().map((path) => (
          <button className={`tree-file ${activePath === path ? "selected" : ""}`} key={path} onClick={() => void engine.seekFile(path)}>
            <span>{path.endsWith(".ts") ? "" : "▤"}</span> {path}
          </button>
        ))}
        <div className="step-section">
          <div className="panel-heading"><span>STEPS</span><span className="muted">{snapshot.steps.length}</span></div>
          {snapshot.steps.map((step) => (
            <button className={`step-row ${snapshot.currentStepId === step.id ? "selected" : ""}`} key={step.id} onClick={() => void engine.seek(step.startSeq)}>
              <span className="step-status">{step.outcome === "succeeded" ? "✓" : "•"}</span>
              <span><strong>{step.label}</strong><small>{step.files.join(", ") || "session"}</small></span>
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace" aria-label="Editor workspace">
        <header className="tab-strip" aria-label="Open files">
          {snapshot.projection.openPaths.map((path) => (
            <button className={`editor-tab ${activePath === path ? "active" : ""}`} key={path} onClick={() => void engine.seekFile(path)}>
              {path.split("/").at(-1)} <span className="tab-close" aria-hidden="true">×</span>
            </button>
          ))}
          <span className="tab-spacer" />
          <span className="lock-indicator">{isLocked ? "🔒 playback" : "replay"}</span>
        </header>
        <div className="editor-wrap" data-testid="monaco-surface">
          {activePath === "" ? <div className="empty-editor">Press play to open the fixture.</div> : (
            <Editor
              path={activePath}
              language={languageFor(activePath)}
              value={activeContent}
              theme={theme === "dark" ? "vs-dark" : "light"}
              onMount={(editor, monaco) => { editorRef.current = editor; monacoRef.current = monaco; }}
              options={{ readOnly: true, minimap: { enabled: true }, lineNumbers: "on", renderLineHighlight: "all", automaticLayout: true, padding: { top: 14 } }}
            />
          )}
        </div>
        <section className="bottom-panel" aria-label="Playback details">
          <div className="bottom-heading"><span>OUTPUT</span><span className="muted">Fixture session · no provider configured</span></div>
          <pre>{snapshot.projection.terminal || "No terminal events in this walking skeleton."}</pre>
        </section>
        <footer className="status-bar">
          <span>{snapshot.state.status}</span>
          <span>Ln {activePath === "" ? 1 : (snapshot.projection.cursors[activePath]?.line ?? 0) + 1}, Col {activePath === "" ? 1 : (snapshot.projection.cursors[activePath]?.column ?? 0) + 1}</span>
          <span className="status-grow" />
          <span>UTF-8</span><span>TypeScript</span>
        </footer>
      </section>

      <section className="transport" aria-label="Transport controls">
        <div className="transport-title"><span>SESSION REPLAY</span><span className="head-label">{snapshot.state.cursor + 1} / {snapshot.state.head + 1}</span></div>
        <div className="transport-row">
          <button data-testid="event-back" title="Previous event" onClick={() => void engine.stepEventBackward()}>◀│</button>
          <button data-testid="step-back" title="Previous step" onClick={() => void engine.stepBackward()}>◀</button>
          <button data-testid="play-pause" className="primary-control" onClick={() => snapshot.state.status === "playing" ? engine.pause() : void engine.play()}>{snapshot.state.status === "playing" ? "Ⅱ" : "▶"}</button>
          <button data-testid="step-forward" title="Next step" onClick={() => void engine.stepForward()}>▶</button>
          <button data-testid="event-forward" title="Next event" onClick={() => void engine.stepEventForward()}>│▶</button>
        </div>
        <div className="seek-row">
          <label htmlFor="timeline">Timeline</label>
          <input id="timeline" data-testid="timeline" type="range" min={-1} max={Math.max(-1, snapshot.state.head)} value={snapshot.state.cursor} onChange={(event) => void engine.seek(Number(event.target.value))} />
        </div>
        <div className="transport-row secondary">
          <label htmlFor="speed">Speed</label>
          <select id="speed" value={snapshot.state.speed} onChange={(event) => engine.setSpeed(Number(event.target.value))}>
            {SPEEDS.map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
          </select>
          <button data-testid="jump-live" onClick={() => void engine.jumpToLive()}>Jump to live</button>
        </div>
        <div className="live-readout">
          {snapshot.stepsBehind > 0 ? <><span className="live-dot" />{snapshot.stepsBehind} {snapshot.stepsBehind === 1 ? "step" : "steps"} behind</> : snapshot.state.status === "ended" ? "End of fixture" : "At live head"}
        </div>
        {snapshot.state.error !== null && <div className="error-box" role="alert">{snapshot.state.error}</div>}
      </section>
    </main>
  );
}
