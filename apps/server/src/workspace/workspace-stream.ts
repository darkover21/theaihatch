import path from "node:path";
import { SesReader, SesWriter, sessionDirectory, type AnySesEvent, type IntegrityStatus, type SesAppender, type SesEventInput } from "../ses.js";

export type WorkspaceStreamSubscriber = (event: AnySesEvent) => void;

const TAIL_LIMIT = 2000;

export class WorkspaceStream implements SesAppender {
  private readonly tail: AnySesEvent[] = [];
  private readonly subscribers = new Set<WorkspaceStreamSubscriber>();
  private openStepId: string | null = null;
  private onAppend: ((headSeq: number, durationMs: number, isCheckpoint: boolean) => void) | null = null;
  private constructor(private readonly writer: SesWriter, private readonly streamPath: string, readonly integrity: IntegrityStatus) {}

  static async open(dataDirectory: string, sessionId: string): Promise<WorkspaceStream> {
    const directory = sessionDirectory(dataDirectory, sessionId);
    const streamPath = path.join(directory, "events.jsonl");
    // Read the integrity of what is already on disk before appending to it, so a resumed session can
    // record whether its prior contents were recovered or clean.
    const integrity = (await SesReader.open(streamPath).then((reader) => reader.integrity, () => "valid" as IntegrityStatus));
    return new WorkspaceStream(await SesWriter.open(directory), streamPath, integrity);
  }

  get currentFiles(): ReadonlyMap<string, string | null> { return this.writer.currentFiles; }
  get headSeq(): number { return this.writer.headSeq; }
  get currentTime(): number { return this.writer.currentTime; }
  get hasOpenStep(): boolean { return this.openStepId !== null; }

  /** Reports committed progress so session metadata can track the head without scanning the stream. */
  observeProgress(listener: (headSeq: number, durationMs: number, isCheckpoint: boolean) => void): void {
    this.onAppend = listener;
  }

  async append(input: SesEventInput): Promise<AnySesEvent[]> {
    if (input.type === "step_begin") {
      if (this.openStepId !== null) await this.append({ type: "step_end", payload: { stepId: this.openStepId, outcome: "succeeded" } });
      this.openStepId = input.payload.stepId;
    } else if (input.type === "step_end" && input.payload.stepId === this.openStepId) {
      this.openStepId = null;
    }
    const events = await this.writer.append(input);
    for (const event of events) {
      this.tail.push(event);
      if (this.tail.length > TAIL_LIMIT) this.tail.shift();
      for (const subscriber of this.subscribers) subscriber(event);
      this.onAppend?.(event.seq, event.t, event.type === "checkpoint");
    }
    return events;
  }

  // Backfill must be gapless: a subscriber whose fromSeq predates the in-memory tail reads the missing
  // span from the durable JSONL first. Live events that arrive mid-backfill are queued, not dropped, and
  // seq tracking makes the handover idempotent where the disk read and the tail overlap.
  subscribe(fromSeq: number, subscriber: WorkspaceStreamSubscriber): () => void {
    let active = true;
    let backfilling = true;
    let nextSeq = fromSeq;
    const queued: AnySesEvent[] = [];
    const forward = (event: AnySesEvent): void => {
      if (!active || event.seq < nextSeq) return;
      nextSeq = event.seq + 1;
      subscriber(event);
    };
    const live = (event: AnySesEvent): void => {
      if (!active) return;
      if (backfilling) queued.push(event);
      else forward(event);
    };
    this.subscribers.add(live);
    void (async () => {
      try {
        const oldestBuffered = this.tail[0]?.seq;
        if (oldestBuffered === undefined || fromSeq < oldestBuffered) {
          const reader = await SesReader.open(this.streamPath);
          const until = oldestBuffered === undefined ? reader.headSeq : oldestBuffered - 1;
          for (const event of (await reader.readRange(fromSeq, until)).events) forward(event);
        }
        for (const event of this.tail) forward(event);
      } catch {
        // The stream may not be readable yet; live events still flow from the queue below.
      } finally {
        backfilling = false;
        for (const event of queued.splice(0)) forward(event);
      }
    })();
    return () => { active = false; this.subscribers.delete(live); };
  }

  async close(): Promise<void> {
    if (this.openStepId !== null) {
      await this.append({ type: "step_end", payload: { stepId: this.openStepId, outcome: "succeeded" } });
      this.openStepId = null;
    }
    await this.writer.close();
  }
}
