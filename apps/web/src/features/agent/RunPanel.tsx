import { useState } from "react";

export interface AgentRunOptions { prompt: string; reviewMode: boolean; dryRun: boolean; }
export interface RunPanelProps { running: boolean; status: string; usage: { inputTokens: number; outputTokens: number; costUsd: number | null }; onRun: (options: AgentRunOptions) => void; onCancel: () => void; }

export function RunPanel({ running, status, usage, onRun, onCancel }: RunPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [reviewMode, setReviewMode] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  return <section aria-label="Agent run" className="run-panel"><textarea aria-label="Agent prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask the agent to change your workspace" disabled={running} /><div className="run-options"><label><input type="checkbox" aria-label="Review each change" checked={reviewMode} onChange={(event) => setReviewMode(event.target.checked)} disabled={running} /> Review each change</label><label><input type="checkbox" aria-label="Dry run" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} disabled={running} /> Dry run</label></div><div className="run-actions"><button onClick={() => { onRun({ prompt: prompt.trim(), reviewMode, dryRun }); setPrompt(""); }} disabled={running || prompt.trim() === ""}>Run</button>{running && <button onClick={onCancel}>Cancel</button>}<span>{status}</span></div><small>{usage.inputTokens + usage.outputTokens} tokens · {usage.costUsd === null ? "cost unavailable" : `$${usage.costUsd.toFixed(4)}`}</small></section>;
}
