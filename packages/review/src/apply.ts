import type { ReviewHunk } from "./diff.js";

export type HunkDecision = { hunkId: string; decision: "accepted" | "rejected"; feedback?: string; actor: string; at: string; };
export interface ApplyResult { content: string; decision: HunkDecision; }
export function applyHunk(content: string, hunk: ReviewHunk, decision: HunkDecision): ApplyResult {
  if (decision.hunkId !== hunk.id) throw new Error("stale hunk fingerprint; refresh review"); if (decision.decision === "rejected") return { content, decision };
  const lines = content.split(/\r?\n/u); const start = lines.findIndex((_, index) => hunk.beforeLines.length === 0 ? index === Math.max(0, hunk.startLine - 1) : lines.slice(index, index + hunk.beforeLines.length).every((line, offset) => line === hunk.beforeLines[offset])); if (start < 0) throw new Error("stale hunk content; refresh review"); lines.splice(start, hunk.beforeLines.length, ...hunk.afterLines); return { content: lines.join("\n"), decision };
}
