import { describe, expect, it } from "vitest";
import { interpolateCursor, scheduleText, scrollTarget } from "../src/index.js";

describe("human typing simulation", () => {
  it("REQ-TYP-001: seeded character timings are deterministic and faster at higher WPM", () => {
    const normal = scheduleText("const answer = 42;", { wpm: 50, seed: 7 });
    const repeat = scheduleText("const answer = 42;", { wpm: 50, seed: 7 });
    const faster = scheduleText("const answer = 42;", { wpm: 100, seed: 7 });
    expect(repeat).toEqual(normal);
    expect(faster.totalDurationMs).toBeLessThan(normal.totalDurationMs);
  });

  it("REQ-TYP-002: line endings, braces, and dense expressions get pause classes", () => {
    const schedule = scheduleText("function run() {\n  return someVeryDenseExpressionWithManyCharactersHere;\n}", { seed: 2 });
    expect(schedule.characters.some((character) => character.pauseClass === "line-ending")).toBe(true);
    expect(schedule.characters.some((character) => character.pauseClass === "after-brace")).toBe(true);
    expect(schedule.characters.some((character) => character.pauseClass === "dense-expression")).toBe(true);
  });

  it("REQ-TYP-003: long edits default to one atomic visible change", () => {
    const schedule = scheduleText(`${"line\n".repeat(81)}tail`);
    expect(schedule.mode).toBe("instant");
    expect(schedule.visibleChangeFlash).toBe(true);
    expect(schedule.characters).toHaveLength(0);
  });

  it("REQ-TYP-004: instant mode is explicit and reversible", () => {
    expect(scheduleText("short", { instantMode: true }).mode).toBe("instant");
    expect(scheduleText("short", { instantMode: false }).mode).toBe("characters");
  });

  it("REQ-TYP-005: cursor easing lands exactly on the recorded position", () => {
    const frames = interpolateCursor({ line: 0, column: 0 }, { line: 12, column: 4 });
    expect(frames[0]?.position).toEqual({ line: 0, column: 0 });
    expect(frames[frames.length - 1]?.position).toEqual({ line: 12, column: 4 });
  });

  it("REQ-TYP-006: scrolling keeps the cursor inside the safe zone", () => {
    expect(scrollTarget({ line: 30, column: 0 }, 0, { viewportLines: 20 })).toBe(15);
    expect(scrollTarget({ line: 5, column: 0 }, 0, { viewportLines: 20 })).toBe(0);
  });
});
