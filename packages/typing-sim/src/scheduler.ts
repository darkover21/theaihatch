export type PauseClass = "none" | "line-ending" | "after-brace" | "dense-expression";
export type TypingMode = "characters" | "instant";

export interface TypingOptions {
  wpm?: number;
  seed?: number;
  jitter?: number;
  lineEndingPauseMs?: number;
  bracePauseMs?: number;
  denseExpressionPauseMs?: number;
  instantMode?: boolean;
  instantCharacterThreshold?: number;
  instantLineThreshold?: number;
}

export interface CharacterTiming {
  index: number;
  character: string;
  atMs: number;
  durationMs: number;
  pauseClass: PauseClass;
}

export interface TypingSchedule {
  mode: TypingMode;
  characters: CharacterTiming[];
  totalDurationMs: number;
  visibleChangeFlash: boolean;
}

export interface ScreenPosition {
  line: number;
  column: number;
}

export interface CursorFrame {
  position: ScreenPosition;
  progress: number;
}

export interface ScrollTargetOptions {
  viewportLines: number;
  safeZoneStart?: number;
  safeZoneEnd?: number;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function isDenseExpression(text: string, index: number): boolean {
  const suffix = text.slice(index);
  return /^(?:const|let|var|return)\s+[^\n]{24,}/u.test(suffix) || /^[([{][^\n]{32,}/u.test(suffix);
}

function classifyPause(text: string, index: number): PauseClass {
  const character = text[index] ?? "";
  if (character === "\n") return "line-ending";
  if (character === "{" && index < text.length - 1) return "after-brace";
  if (isDenseExpression(text, index)) return "dense-expression";
  return "none";
}

export function scheduleText(text: string, options: TypingOptions = {}): TypingSchedule {
  const wpm = Math.max(1, options.wpm ?? 55);
  const seed = options.seed ?? 1;
  const jitter = Math.max(0, Math.min(0.8, options.jitter ?? 0.18));
  const instantCharacterThreshold = options.instantCharacterThreshold ?? 2000;
  const instantLineThreshold = options.instantLineThreshold ?? 80;
  const lineCount = text.split("\n").length;
  const isInstant = options.instantMode === true || text.length > instantCharacterThreshold || lineCount > instantLineThreshold;
  if (isInstant) {
    return { mode: "instant", characters: [], totalDurationMs: 0, visibleChangeFlash: true };
  }

  const random = makeRandom(seed);
  const baseDuration = 12000 / (wpm * 5);
  const characters: CharacterTiming[] = [];
  let elapsed = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    const pauseClass = classifyPause(text, index);
    const pause = pauseClass === "line-ending"
      ? options.lineEndingPauseMs ?? 220
      : pauseClass === "after-brace"
        ? options.bracePauseMs ?? 160
        : pauseClass === "dense-expression"
          ? options.denseExpressionPauseMs ?? 180
          : 0;
    elapsed += pause;
    const factor = 1 - jitter + random() * jitter * 2;
    const durationMs = Math.max(1, baseDuration * factor);
    characters.push({ index, character, atMs: elapsed, durationMs, pauseClass });
    elapsed += durationMs;
  }
  return { mode: "characters", characters, totalDurationMs: elapsed, visibleChangeFlash: false };
}

function easeInOut(value: number): number {
  return value < 0.5 ? 2 * value * value : 1 - ((-2 * value + 2) ** 2) / 2;
}

export function interpolateCursor(from: ScreenPosition, to: ScreenPosition, frameCount = 8, maxDurationMs = 240): CursorFrame[] {
  const count = Math.max(2, Math.floor(frameCount));
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1);
    const eased = easeInOut(progress);
    return {
      progress,
      position: {
        line: Math.round(from.line + (to.line - from.line) * eased),
        column: Math.round(from.column + (to.column - from.column) * eased)
      }
    };
  }).map((frame) => ({ ...frame, progress: Math.min(1, frame.progress * (maxDurationMs / Math.max(1, maxDurationMs))) }));
}

export function scrollTarget(position: ScreenPosition, currentScrollTop: number, options: ScrollTargetOptions): number {
  const start = options.safeZoneStart ?? Math.max(1, Math.floor(options.viewportLines * 0.25));
  const end = options.safeZoneEnd ?? Math.max(start + 1, Math.floor(options.viewportLines * 0.75));
  const relativeLine = position.line - currentScrollTop;
  if (relativeLine < start) return Math.max(0, position.line - start);
  if (relativeLine > end) return Math.max(0, position.line - end);
  return currentScrollTop;
}
