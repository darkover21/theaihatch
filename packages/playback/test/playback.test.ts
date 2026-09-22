import { describe, expect, it } from "vitest";
import type { AnySesEvent } from "@theaihatch/ses";
import { PlaybackEngine, MemoryEventSource, playbackReducer, initialPlaybackState } from "../src/index.js";

const events: AnySesEvent[] = [
  { seq: 0, t: 0, type: "file_create", payload: { path: "src/app.ts" } },
  { seq: 1, t: 10, type: "step_begin", payload: { stepId: "one", label: "Create app.ts", primaryPath: "src/app.ts" } },
  { seq: 2, t: 20, type: "file_open", payload: { path: "src/app.ts", preview: false } },
  { seq: 3, t: 30, type: "edit_insert", payload: { path: "src/app.ts", position: { line: 0, column: 0 }, text: "hello\n" } },
  { seq: 4, t: 40, type: "step_end", payload: { stepId: "one", outcome: "succeeded" } },
  { seq: 5, t: 50, type: "checkpoint", payload: { reason: "final", files: [{ path: "src/app.ts", content: "hello\n", contentHash: "hash" }] } },
  { seq: 6, t: 60, type: "step_begin", payload: { stepId: "two", label: "Add line", primaryPath: "src/app.ts" } },
  { seq: 7, t: 70, type: "edit_insert", payload: { path: "src/app.ts", position: { line: 1, column: 0 }, text: "world\n" } },
  { seq: 8, t: 80, type: "step_end", payload: { stepId: "two", outcome: "succeeded" } }
];

describe("playback state machine", () => {
  it("REQ-PLY-001: legal transitions expose explicit playback states", () => {
    const loaded = playbackReducer(initialPlaybackState, { type: "loaded", head: 2 });
    expect(loaded.status).toBe("paused");
    expect(playbackReducer(loaded, { type: "play" }).status).toBe("playing");
    expect(playbackReducer(loaded, { type: "seek-start" }).status).toBe("seeking");
    expect(playbackReducer(loaded, { type: "error", message: "bad read" }).status).toBe("error");
  });

  it("REQ-PLY-002: play, pause, and supported speed values preserve order", async () => {
    const engine = new PlaybackEngine(new MemoryEventSource(events));
    await engine.load();
    engine.setSpeed(2);
    expect(engine.getSnapshot().state.speed).toBe(2);
    const play = engine.play();
    engine.pause();
    await play;
    expect(engine.getSnapshot().state.cursor).toBeGreaterThanOrEqual(0);
    expect(engine.getSnapshot().state.status).not.toBe("error");
  });

  it("REQ-PLY-003: event stepping moves forward and reconstructs backward", async () => {
    const engine = new PlaybackEngine(new MemoryEventSource(events));
    await engine.load();
    await engine.stepEventForward();
    await engine.stepEventForward();
    expect(engine.getSnapshot().state.cursor).toBe(1);
    await engine.stepEventBackward();
    expect(engine.getSnapshot().state.cursor).toBe(0);
  });

  it("REQ-PLY-004 and REQ-STP-005: group stepping lands at boundaries", async () => {
    // stepForward now animates, so the injected sleep keeps this exercising the animated path without
    // paying a real per-character delay. The cursor assertions also prove animated and instant playback
    // land on the same sequence.
    const engine = new PlaybackEngine(new MemoryEventSource(events), { sleep: async () => undefined });
    await engine.load();
    await engine.seek(3);
    await engine.stepForward();
    expect(engine.getSnapshot().state.cursor).toBe(4);
    await engine.stepBackward();
    expect(engine.getSnapshot().state.cursor).toBe(0);
  });

  it("REQ-PLY-004: repeated step-forward keeps advancing past a step boundary", async () => {
    const engine = new PlaybackEngine(new MemoryEventSource(events), { sleep: async () => undefined });
    await engine.load();
    // Landing exactly on a step's end used to match that same step again, so the seek was a no-op and
    // the button did nothing from then on.
    await engine.stepForward();
    const first = engine.getSnapshot().state.cursor;
    await engine.stepForward();
    const second = engine.getSnapshot().state.cursor;
    expect(second).toBeGreaterThan(first);
  });

  it("REQ-STP-005: playStep replays one step and stops at its end", async () => {
    const engine = new PlaybackEngine(new MemoryEventSource(events), { sleep: async () => undefined });
    await engine.load();
    const step = engine.getSnapshot().steps[1];
    expect(step).toBeDefined();
    await engine.playStep(step!.id);
    expect(engine.getSnapshot().state.cursor).toBe(step!.endSeq);
    // A bounded run settles on paused, not at-live-head, or the source subscription would restart it.
    expect(engine.getSnapshot().state.status).toBe("paused");
  });

  it("play during a bounded step replay promotes it to unbounded", async () => {
    const engine = new PlaybackEngine(new MemoryEventSource(events), { sleep: async () => undefined });
    await engine.load();
    const step = engine.getSnapshot().steps[0];
    expect(step).toBeDefined();
    const bounded = engine.playStep(step!.id);
    await engine.play();
    await bounded;
    // Promoted, so it ran past the step's end rather than stopping there.
    expect(engine.getSnapshot().state.cursor).toBeGreaterThan(step!.endSeq);
  });

  it("REQ-PLY-005 and REQ-SES-006: seek restores the nearest checkpoint", async () => {
    const engine = new PlaybackEngine(new MemoryEventSource(events));
    await engine.load();
    await engine.seek(8);
    expect(engine.getSnapshot().projection.files["src/app.ts"]).toBe("hello\nworld\n");
    await engine.seekFile("src/app.ts", 0);
    expect(engine.getSnapshot().projection.activePath).toBe("src/app.ts");
  });

  it("REQ-PLY-006: behind-live reports completed step boundaries", async () => {
    const engine = new PlaybackEngine(new MemoryEventSource(events));
    await engine.load();
    await engine.seek(0);
    expect(engine.getSnapshot().stepsBehind).toBe(2);
  });

  it("REQ-PLY-007: a live source follows appended events through the same path", async () => {
    const source = new MemoryEventSource(events.slice(0, 6), true);
    const engine = new PlaybackEngine(source);
    await engine.load();
    await engine.seek(5);
    const play = engine.play();
    await new Promise((resolve) => setTimeout(resolve, 5));
    source.append(events[6]!);
    source.append(events[7]!);
    source.append(events[8]!);
    engine.pause();
    await play;
    expect(engine.getSnapshot().state.cursor).toBeGreaterThanOrEqual(5);
  });
});

it("REQ-TYP-005: exposes a caret that advances per character and lands at the end of an insert", async () => {
  const engine = new PlaybackEngine(new MemoryEventSource(events));
  await engine.load();
  const carets: Array<{ path: string; line: number; column: number }> = [];
  const unsubscribe = engine.subscribe((snapshot) => {
    if (snapshot.caret !== null) carets.push({ path: snapshot.caret.path, line: snapshot.caret.position.line, column: snapshot.caret.position.column });
  });
  engine.setSpeed(32);
  await engine.seek(3);
  await engine.stepEventForward();
  const play = engine.play();
  await new Promise((resolve) => setTimeout(resolve, 400));
  engine.pause();
  await play;
  unsubscribe();

  expect(carets.length).toBeGreaterThan(5);
  // The caret sits after the glyph just typed, so it advances rather than repeating one position.
  const distinct = new Set(carets.map((caret) => `${caret.line}:${caret.column}`));
  expect(distinct.size).toBeGreaterThan(5);

  // A seek is not typing, so it clears the caret and the UI falls back to the recorded cursor.
  await engine.seek(3);
  expect(engine.getSnapshot().caret).toBeNull();
});

it("REQ-EDT-005: an animated cursor_move validates the same way an instant one does", async () => {
  const stream: AnySesEvent[] = [
    { seq: 0, t: 0, type: "workspace_open", payload: { rootName: "demo", canonicalRoot: "/demo" } },
    { seq: 1, t: 1, type: "cursor_move", payload: { path: "missing.ts", position: { line: 0, column: 0 } } }
  ];

  // Stepping surfaces the rejection by throwing out of applyNext; only the run loop turns it into state.
  const instant = new PlaybackEngine(new MemoryEventSource(stream));
  await instant.load();
  await instant.stepEventForward();
  await expect(instant.stepEventForward()).rejects.toThrow("file is not present");

  // Before, the animated branch wrote projection.cursors directly and skipped these checks, so the same
  // stream errored when stepped but played happily when animated.
  const animated = new PlaybackEngine(new MemoryEventSource(stream));
  await animated.load();
  animated.setSpeed(32);
  await animated.play();
  expect(animated.getSnapshot().state.status).toBe("error");
});
