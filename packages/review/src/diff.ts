import { createHash } from "node:crypto";

export interface ReviewHunk { id: string; path: string; startLine: number; beforeLines: string[]; afterLines: string[]; fingerprint: string; eventSeq?: number; }
export interface FileDiff { path: string; before: string; after: string; binary: boolean; hunks: ReviewHunk[]; }
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function diffFile(path: string, before: string, after: string, eventSeq?: number): FileDiff {
  const binary = before.includes("\u0000") || after.includes("\u0000"); if (binary) return { path, before, after, binary, hunks: [] }; if (before === after) return { path, before, after, binary, hunks: [] };
  const beforeLines = before.split(/\r?\n/u); const afterLines = after.split(/\r?\n/u); const hunks: ReviewHunk[] = []; let beforeIndex = 0; let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) { beforeIndex += 1; afterIndex += 1; continue; }
    const startBefore = beforeIndex; const startAfter = afterIndex;
    while (beforeIndex < beforeLines.length && afterIndex < afterLines.length && beforeLines[beforeIndex] !== afterLines[afterIndex]) {
      const nextBeforeMatch = afterLines.slice(afterIndex, afterIndex + 8).findIndex((line) => line === beforeLines[beforeIndex]);
      const nextAfterMatch = beforeLines.slice(beforeIndex, beforeIndex + 8).findIndex((line) => line === afterLines[afterIndex]);
      if (nextBeforeMatch > 0 && (nextAfterMatch < 0 || nextBeforeMatch <= nextAfterMatch)) afterIndex += nextBeforeMatch;
      else if (nextAfterMatch > 0) beforeIndex += nextAfterMatch;
      else { beforeIndex += 1; afterIndex += 1; }
      if (beforeLines[beforeIndex] === afterLines[afterIndex]) break;
    }
    while (beforeIndex < beforeLines.length && afterIndex >= afterLines.length) beforeIndex += 1;
    while (afterIndex < afterLines.length && beforeIndex >= beforeLines.length) afterIndex += 1;
    const hunkBase = { path, startLine: startBefore + 1, beforeLines: beforeLines.slice(startBefore, beforeIndex), afterLines: afterLines.slice(startAfter, afterIndex), ...(eventSeq === undefined ? {} : { eventSeq }) }; const id = fingerprint(hunkBase); hunks.push({ ...hunkBase, id, fingerprint: id });
  }
  return { path, before, after, binary, hunks };
}
export function diffFiles(files: Array<{ path: string; before: string; after: string; eventSeq?: number }>): FileDiff[] { return files.map((file) => diffFile(file.path, file.before, file.after, file.eventSeq)); }
