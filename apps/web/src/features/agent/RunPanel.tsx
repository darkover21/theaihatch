import { useState } from "react";

export interface RunPanelProps { running: boolean; status: string; usage: { inputTokens: number; outputTokens: number; costUsd: number | null }; onRun: (prompt: string) => void; onCancel: () => void; }

export function RunPanel({ running, status, usage, onRun, onCancel }: RunPanelProps) {
  const [prompt, setPrompt] = useState("");
  return <section aria-label="Agent run" className="run-panel"><textarea aria-label="Agent prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask the agent to change your workspace" disabled={running} /><button onClick={() => { onRun(prompt); setPrompt(""); }} disabled={running || prompt.trim() === ""}>Run</button>{running && <button onClick={onCancel}>Cancel</button>}<span>{status}</span><small>{usage.inputTokens + usage.outputTokens} tokens · {usage.costUsd === null ? "cost unavailable" : `$${usage.costUsd.toFixed(4)}`}</small></section>;
}
