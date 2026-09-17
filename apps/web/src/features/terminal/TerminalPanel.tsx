import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";
import { useEffect, useRef } from "react";
import "xterm/css/xterm.css";

export interface TerminalEvent {
  stream: "stdout" | "stderr";
  chunk: string;
  eof: boolean;
  exitCode?: number;
  signal?: string;
}

export interface TerminalPanelProps {
  command?: string;
  events: readonly TerminalEvent[];
  collapsed: boolean;
  height: number;
  onToggle: () => void;
  onHeightChange: (height: number) => void;
}

export function TerminalPanel({ command, events, collapsed, height, onToggle, onHeightChange }: TerminalPanelProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const renderedEvents = useRef(0);

  useEffect(() => {
    if (host.current === null || terminal.current !== null) return;
    const instance = new Terminal({ convertEol: true, cursorBlink: false, theme: { background: "#141922", foreground: "#c7d2e3", red: "#ed6f7b" } });
    const addon = new FitAddon();
    instance.loadAddon(addon);
    instance.open(host.current);
    addon.fit();
    terminal.current = instance;
    fit.current = addon;
    const resize = (): void => addon.fit();
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); instance.dispose(); terminal.current = null; fit.current = null; };
  }, []);

  useEffect(() => {
    const instance = terminal.current;
    if (instance === null) return;
    if (renderedEvents.current > events.length) { instance.clear(); instance.reset(); renderedEvents.current = 0; }
    for (const event of events.slice(renderedEvents.current)) {
      instance.write(event.stream === "stderr" ? `\x1b[31m${event.chunk}\x1b[0m` : event.chunk);
      if (event.eof) instance.write("\r\n");
    }
    renderedEvents.current = events.length;
  }, [events]);

  return (
    <section className={`terminal-panel ${collapsed ? "collapsed" : ""}`} aria-label="Terminal panel" style={{ height: collapsed ? 30 : height }}>
      <div className="terminal-toolbar">
        <button onClick={onToggle} aria-expanded={!collapsed}>{collapsed ? "▸" : "▾"} TERMINAL</button>
        {command !== undefined && <span className="terminal-command">{command}</span>}
        {!collapsed && <input aria-label="Terminal height" type="range" min="120" max="520" value={height} onChange={(event) => onHeightChange(Number(event.target.value))} />}
      </div>
      {!collapsed && <div className="terminal-host" ref={host} />}
    </section>
  );
}
