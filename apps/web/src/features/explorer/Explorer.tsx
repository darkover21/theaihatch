import { useEffect, useState } from "react";

export interface ExplorerEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface ExplorerProps {
  rootName: string;
  entries: readonly ExplorerEntry[];
  activePath: string | null;
  decorations?: Readonly<Record<string, string>>;
  onOpenFile: (path: string) => void;
  onExpand: (path: string) => Promise<ExplorerEntry[]>;
}

function decorationFor(path: string, decorations: Readonly<Record<string, string>> | undefined): string {
  const status = decorations?.[path];
  return status === undefined ? "" : ` · ${status}`;
}

export function Explorer({ rootName, entries, activePath, decorations, onOpenFile, onExpand }: ExplorerProps) {
  const [children, setChildren] = useState<Record<string, ExplorerEntry[]>>({ ".": [...entries] });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => { setChildren((current) => ({ ...current, ".": [...entries] })); }, [entries]);
  const toggle = async (entry: ExplorerEntry): Promise<void> => {
    if (entry.kind !== "directory") return;
    if (expanded.has(entry.path)) {
      setExpanded((current) => new Set([...current].filter((path) => path !== entry.path)));
      return;
    }
    const loaded = await onExpand(entry.path);
    setChildren((current) => ({ ...current, [entry.path]: loaded }));
    setExpanded((current) => new Set([...current, entry.path]));
  };
  const render = (items: readonly ExplorerEntry[], depth: number): JSX.Element[] => items.flatMap((entry) => {
    const item = (
      <div className="explorer-entry" key={entry.path} style={{ paddingLeft: 14 + depth * 12 }}>
        {entry.kind === "directory" ? <button className="explorer-toggle" aria-label={`${expanded.has(entry.path) ? "Collapse" : "Expand"} ${entry.path}`} onClick={() => void toggle(entry)}>{expanded.has(entry.path) ? "▾" : "▸"}</button> : <span className="explorer-toggle">·</span>}
        <button className={`tree-file ${activePath === entry.path ? "selected" : ""}`} onClick={() => entry.kind === "directory" ? void toggle(entry) : onOpenFile(entry.path)}>
          <span>{entry.kind === "directory" ? "▰" : "▤"}</span> {entry.name}<span className="git-decoration">{decorationFor(entry.path, decorations)}</span>
        </button>
      </div>
    );
    return expanded.has(entry.path) ? [item, ...render(children[entry.path] ?? [], depth + 1)] : [item];
  });

  return (
    <aside className="explorer-panel" aria-label="Explorer">
      <div className="panel-heading"><span>EXPLORER</span><span className="muted">{rootName}</span></div>
      <div className="tree-root">▾ <span>{rootName}</span></div>
      <div>{render(children["."] ?? [], 0)}</div>
    </aside>
  );
}
