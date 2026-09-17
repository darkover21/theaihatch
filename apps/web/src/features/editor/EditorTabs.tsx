import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";

export interface EditorTab {
  path: string;
  content: string;
  dirty?: boolean;
}

export interface EditorTabsProps {
  tabs: readonly EditorTab[];
  activePath: string | null;
  theme: "dark" | "light";
  readOnly: boolean;
  onFocus: (path: string) => void;
  onClose: (path: string) => void;
  onSave?: (path: string) => void;
  onChange?: (path: string, content: string) => void;
  onMount?: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void;
}

function languageFor(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".css")) return "css";
  return "plaintext";
}

export function EditorTabs({ tabs, activePath, theme, readOnly, onFocus, onClose, onSave, onChange, onMount }: EditorTabsProps) {
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? tabs[0];
  const close = (path: string, dirty: boolean | undefined): void => {
    if (dirty) {
      const save = window.confirm(`Save changes in ${path}? OK saves, Cancel discards.`);
      if (save) onSave?.(path);
    }
    onClose(path);
  };

  return (
    <>
      <header className="tab-strip" aria-label="Open files">
        {tabs.map((tab) => (
          <button className={`editor-tab ${activeTab?.path === tab.path ? "active" : ""}`} key={tab.path} onClick={() => onFocus(tab.path)}>
            {tab.path.split("/").at(-1)}{tab.dirty ? " •" : ""}
            <span className="tab-close" aria-label={`Close ${tab.path}`} onClick={(event) => { event.stopPropagation(); close(tab.path, tab.dirty); }}>×</span>
          </button>
        ))}
        <span className="tab-spacer" />
        <span className="lock-indicator">{readOnly ? "🔒 playback" : "workspace"}</span>
      </header>
      <div className="editor-wrap" data-testid="monaco-surface">
        {activeTab === undefined ? <div className="empty-editor">Open a file to begin.</div> : (
          <Editor
            path={activeTab.path}
            language={languageFor(activeTab.path)}
            value={activeTab.content}
            theme={theme === "dark" ? "vs-dark" : "light"}
            onMount={(mountedEditor, mountedMonaco) => {
              onMount?.(mountedEditor, mountedMonaco);
            }}
            onChange={(value) => { if (!readOnly && value !== undefined) onChange?.(activeTab.path, value); }}
            options={{ readOnly, minimap: { enabled: true }, lineNumbers: "on", renderLineHighlight: "all", automaticLayout: true, padding: { top: 14 } }}
          />
        )}
      </div>
    </>
  );
}
