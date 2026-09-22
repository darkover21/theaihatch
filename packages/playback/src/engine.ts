import type { AnySesEvent, Position } from "@theaihatch/ses/browser";
import { offsetToPosition, positionToOffset } from "@theaihatch/ses/browser";
import { scheduleText, interpolateCursor } from "@theaihatch/typing-sim";
import { applyProjectionEvent, cloneProjection, emptyProjection, restoreCheckpointFiles, type ProjectionState } from "./projection.js";
import { initialPlaybackState, playbackReducer, type PlaybackState } from "./state-machine.js";
import { buildStepIndex, type PlaybackStep } from "./steps.js";
import type { EventSource } from "./source.js";

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;

export interface PlaybackSnapshot {
  state: PlaybackState;
  projection: ProjectionState;
  steps: PlaybackStep[];
  currentStepId: string | null;
  stepsBehind: number;
  /**
   * Where the typing caret is right now, so the editor can follow an edit as it animates.
   *
   * Deliberately not part of ProjectionState. `seek` rebuilds the projection from a checkpoint and then
   * replays only UI events, which excludes every edit_*, so a cursor written by an edit would exist on a
   * linearly played projection and not on a seeked one. That divergence is exactly what the seek/linear
   * determinism test compares. Keeping the caret out here means animated and instant playback still
   * produce byte-identical projections, and the caret is a playhead detail rather than session state.
   */
  caret: { path: string; position: Position } | null;
}

export type PlaybackListener = (snapshot: PlaybackSnapshot) => void;

function clampSpeed(speed: number): number {
  return PLAYBACK_SPEEDS.reduce((closest, candidate) => Math.abs(candidate - speed) < Math.abs(closest - speed) ? candidate : closest, PLAYBACK_SPEEDS[0]);
}

function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PlaybackEngine {
  private state: PlaybackState = initialPlaybackState;
  private projection: ProjectionState = emptyProjection();
  private events = new Map<number, AnySesEvent>();
  private steps: PlaybackStep[] = [];
  private readonly listeners = new Set<PlaybackListener>();
  private runPromise: Promise<void> | null = null;
  private pauseRequested = false;
  private readonly appendWaiters = new Set<() => void>();
  private readonly unsubscribeSource: () => void;
  private disposed = false;
  private caret: { path: string; position: Position } | null = null;

  constructor(private readonly source: EventSource) {
    this.unsubscribeSource = source.subscribe(() => {
      for (const resolve of this.appendWaiters) resolve();
      this.appendWaiters.clear();
      this.refreshHead();
      void this.refreshLiveIndex();
      if (this.state.status === "at-live-head" && this.runPromise === null) void this.play();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeSource();
    this.pause();
  }

  append(event: AnySesEvent): void {
    const append = (this.source as EventSource & { append?: (value: AnySesEvent) => void }).append;
    if (append === undefined) throw new Error("playback source is not appendable");
    append.call(this.source, event);
  }

  private async refreshLiveIndex(): Promise<void> {
    if (this.disposed) return;
    const head = this.source.getHeadSeq();
    const range = await this.source.readRange(0, head);
    this.events = new Map(range.events.map((event) => [event.seq, event]));
    this.steps = buildStepIndex(range.events);
    this.emit();
  }

  async load(): Promise<void> {
    try {
      const head = this.source.getHeadSeq();
      const range = await this.source.readRange(0, head);
      this.events = new Map(range.events.map((event) => [event.seq, event]));
      this.steps = buildStepIndex(range.events);
      this.state = playbackReducer(this.state, { type: "loaded", head });
      this.projection = emptyProjection();
      this.caret = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): PlaybackSnapshot {
    const currentStep = this.steps.find((step) => this.state.cursor >= step.startSeq && this.state.cursor <= step.endSeq);
    return {
      state: { ...this.state },
      projection: cloneProjection(this.projection),
      steps: this.steps.map((step) => ({ ...step, files: [...step.files] })),
      currentStepId: currentStep?.id ?? null,
      stepsBehind: this.steps.filter((step) => step.endSeq > this.state.cursor && step.endSeq <= this.state.head).length,
      caret: this.caret === null ? null : { path: this.caret.path, position: { ...this.caret.position } }
    };
  }

  async play(): Promise<void> {
    if (this.runPromise !== null) return this.runPromise;
    if (this.state.status === "error" || this.state.status === "loading" || this.state.status === "seeking") return;
    if (!this.source.live && this.state.cursor >= this.state.head) {
      this.state = { ...this.state, status: "ended" };
      this.emit();
      return;
    }
    this.pauseRequested = false;
    this.state = playbackReducer(this.state, { type: "play" });
    this.emit();
    this.runPromise = this.runLoop();
    try {
      await this.runPromise;
    } finally {
      this.runPromise = null;
    }
  }

  pause(): void {
    this.pauseRequested = true;
    for (const resolve of this.appendWaiters) resolve();
    this.appendWaiters.clear();
    if (this.runPromise === null) {
      this.state = playbackReducer(this.state, { type: "pause" });
      this.emit();
    }
  }

  setSpeed(speed: number): void {
    this.state = playbackReducer(this.state, { type: "speed", speed: clampSpeed(speed) });
    this.emit();
  }

  async stepEventForward(): Promise<void> {
    await this.stopPlayback();
    if (this.state.cursor >= this.state.head) return;
    await this.applyNext(false);
  }

  async stepEventBackward(): Promise<void> {
    await this.stopPlayback();
    await this.seek(this.state.cursor - 1);
  }

  async stepForward(): Promise<void> {
    await this.stopPlayback();
    const current = this.steps.find((step) => this.state.cursor >= step.startSeq && this.state.cursor <= step.endSeq);
    const next = current === undefined ? this.steps.find((step) => step.startSeq > this.state.cursor) : current;
    if (next !== undefined) await this.seek(next.endSeq);
  }

  async stepBackward(): Promise<void> {
    await this.stopPlayback();
    const current = this.steps.find((step) => this.state.cursor >= step.startSeq && this.state.cursor <= step.endSeq);
    if (current !== undefined) {
      await this.seek(current.startSeq - 1);
      return;
    }
    const previous = [...this.steps].reverse().find((step) => step.endSeq < this.state.cursor);
    if (previous !== undefined) await this.seek(previous.startSeq - 1);
  }

  async seek(targetSeq: number): Promise<void> {
    await this.stopPlayback();
    this.state = playbackReducer(this.state, { type: "seek-start" });
    this.emit();
    try {
      const head = this.source.getHeadSeq();
      const target = Math.max(-1, Math.min(targetSeq, head));
      const checkpoint = this.source.getCheckpointAtOrBefore(target);
      const nextProjection = emptyProjection();
      if (checkpoint !== null) restoreCheckpointFiles(nextProjection, checkpoint);
      if (checkpoint !== null) {
        const uiRange = await this.source.readRange(0, checkpoint.seq);
        for (const event of uiRange.events) {
          if (["file_open", "file_close", "tab_focus", "file_rename", "file_delete", "cursor_move", "selection_change", "scroll"].includes(event.type)) {
            applyProjectionEvent(nextProjection, event);
          }
        }
      }
      const from = checkpoint === null ? 0 : checkpoint.seq + 1;
      const range = await this.source.readRange(from, target);
      for (const event of range.events) {
        this.events.set(event.seq, event);
        applyProjectionEvent(nextProjection, event);
      }
      this.projection = nextProjection;
      // A seek is not typing, so there is no live caret; the UI falls back to the cursor the stream
      // recorded, which is what "jump directly to the recorded position" means for a restore.
      this.caret = null;
      this.steps = buildStepIndex([...this.events.values()].sort((left, right) => left.seq - right.seq));
      this.state = playbackReducer(this.state, { type: "seek-complete", cursor: target, head, live: this.source.live });
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }

  async seekFile(path: string, occurrence = 0): Promise<void> {
    const match = this.source.getFileOccurrences(path)[occurrence];
    if (match === undefined) throw new Error(`no event for ${path}`);
    await this.seek(match.seq);
    if (!this.projection.openPaths.includes(path) && this.projection.files[path] !== undefined) this.projection.openPaths.push(path);
    this.projection.activePath = path;
    this.emit();
  }

  async jumpToLive(): Promise<void> {
    await this.stopPlayback();
    this.pauseRequested = false;
    this.state = playbackReducer(this.state, { type: "seek-start" });
    this.emit();
    try {
      while (this.state.cursor < this.source.getHeadSeq()) await this.applyNext(false);
      this.state = { ...this.state, status: this.source.live ? "at-live-head" : "ended", head: this.source.getHeadSeq() };
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }

  private async runLoop(): Promise<void> {
    try {
      while (!this.pauseRequested) {
        this.refreshHead();
        if (this.state.cursor >= this.state.head) {
          if (!this.source.live) {
            this.state = { ...this.state, status: "ended" };
            this.emit();
            return;
          }
          this.state = { ...this.state, status: "at-live-head" };
          this.emit();
          await this.waitForAppend();
          if (this.pauseRequested) break;
          this.state = { ...this.state, status: "playing" };
          this.emit();
          continue;
        }
        await this.applyNext(true);
      }
      if (this.pauseRequested && this.state.status !== "error") {
        this.state = { ...this.state, status: "paused" };
        this.emit();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private async applyNext(animate: boolean): Promise<void> {
    const nextSeq = this.state.cursor + 1;
    const event = await this.getEvent(nextSeq);
    if (event === undefined) throw new Error(`missing event ${nextSeq}`);
    await this.animateEvent(event, animate);
    this.state = playbackReducer(this.state, { type: "cursor", cursor: event.seq, head: this.source.getHeadSeq() });
    this.emit();
  }

  private async animateEvent(event: AnySesEvent, animate: boolean): Promise<void> {
    if (event.type === "edit_insert" && animate) {
      const content = this.projection.files[event.payload.path];
      if (content === undefined) throw new Error(`file is not present: ${event.payload.path}`);
      const baseOffset = positionToOffset(content, event.payload.position);
      const schedule = scheduleText(event.payload.text, { seed: event.seq });
      if (schedule.mode === "instant") {
        applyProjectionEvent(this.projection, event);
        this.emit();
        return;
      }
      let inserted = "";
      for (const character of schedule.characters) {
        const current = this.projection.files[event.payload.path];
        if (current === undefined) throw new Error(`file disappeared: ${event.payload.path}`);
        const position = offsetToPosition(current, baseOffset + inserted.length);
        applyProjectionEvent(this.projection, { ...event, payload: { ...event.payload, position, text: character.character } });
        inserted += character.character;
        // Read the caret after the character lands, so it sits after the glyph the viewer just saw
        // typed rather than one position behind it.
        const applied = this.projection.files[event.payload.path];
        this.caret = applied === undefined ? null : { path: event.payload.path, position: offsetToPosition(applied, baseOffset + inserted.length) };
        this.emit();
        await sleep(character.durationMs / this.state.speed);
      }
      return;
    }
    if (event.type === "cursor_move" && animate) {
      const from = this.projection.cursors[event.payload.path] ?? { line: 0, column: 0 };
      for (const frame of interpolateCursor(from, event.payload.position)) {
        // Routed through applyProjectionEvent rather than written directly, so the file-present and
        // tab-open checks run on every frame exactly as they do when the same event is applied instantly.
        applyProjectionEvent(this.projection, { ...event, payload: { ...event.payload, position: frame.position } });
        this.caret = { path: event.payload.path, position: frame.position };
        this.emit();
        await sleep(20 / this.state.speed);
      }
      return;
    }
    applyProjectionEvent(this.projection, event);
    if (animate) await sleep(Math.max(20, Math.min(140, event.t - (this.events.get(event.seq - 1)?.t ?? event.t))) / this.state.speed);
    this.emit();
  }

  private async getEvent(seq: number): Promise<AnySesEvent | undefined> {
    const cached = this.events.get(seq);
    if (cached !== undefined) return cached;
    const range = await this.source.readRange(seq, seq);
    const event = range.events[0];
    if (event !== undefined) this.events.set(event.seq, event);
    return event;
  }

  private async stopPlayback(): Promise<void> {
    this.pause();
    if (this.runPromise !== null) await this.runPromise;
  }

  private waitForAppend(): Promise<void> {
    return new Promise((resolve) => this.appendWaiters.add(resolve));
  }

  private refreshHead(): void {
    const head = this.source.getHeadSeq();
    if (head !== this.state.head) {
      this.state = playbackReducer(this.state, { type: "head", head });
      this.emit();
    }
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.state = playbackReducer(this.state, { type: "error", message });
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
