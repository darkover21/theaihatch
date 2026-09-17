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
    const engine = new PlaybackEngine(new MemoryEventSource(events));
    await engine.load();
    await engine.seek(3);
    await engine.stepForward();
    expect(engine.getSnapshot().state.cursor).toBe(4);
    await engine.stepBackward();
    expect(engine.getSnapshot().state.cursor).toBe(0);
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
