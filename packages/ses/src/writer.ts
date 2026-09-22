import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AnySesEvent, SesEventInput, SesEventType } from "./schema.js";
import { isCheckpoint, sesEventSchema } from "./schema.js";
import { applyFileEvent, checkpointFiles, cloneFileProjection, createFileProjection, type CheckpointScope, type FileProjectionState } from "./checkpoints.js";
import { SesReader } from "./reader.js";

export interface SesWriterOptions {
  clock?: () => number;
  sessionStartMs?: number;
}

export interface SesAppender {
  append(input: SesEventInput): Promise<AnySesEvent[]>;
  readonly currentFiles: ReadonlyMap<string, string | null>;
}

function ensureSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(sessionId)) throw new Error("invalid session identifier");
}

export function sessionDirectory(dataDir: string, sessionId: string): string {
  ensureSafeSessionId(sessionId);
  return path.resolve(dataDir, "sessions", sessionId);
}

export class SesWriter implements SesAppender {
  private readonly streamPath: string;
  private readonly clock: () => number;
  private readonly sessionStartMs: number;
  private handle: FileHandle | null = null;
  private sequence = -1;
  private lastTime = 0;
  private eventsSinceCheckpoint = 0;
  private projection: FileProjectionState = createFileProjection();
  private queue: Promise<void> = Promise.resolve();
  /** Bytes of "delta" checkpoints written since the last full one, and the size that full one cost. */
  private deltaBytesSinceFull = 0;
  private lastFullCheckpointBytes = 0;

  private constructor(streamPath: string, options: SesWriterOptions) {
    this.streamPath = streamPath;
    this.clock = options.clock ?? Date.now;
    this.sessionStartMs = options.sessionStartMs ?? this.clock();
  }

  static async open(sessionDir: string, options: SesWriterOptions = {}): Promise<SesWriter> {
    const writer = new SesWriter(path.resolve(sessionDir, "events.jsonl"), options);
    await fs.mkdir(path.dirname(writer.streamPath), { recursive: true });
    const reader = await SesReader.open(writer.streamPath);
    const existing = await reader.readRange(0, reader.headSeq);
    for (const event of existing.events) {
      writer.sequence = event.seq;
      writer.lastTime = event.t;
      if (isCheckpoint(event)) {
        writer.eventsSinceCheckpoint = 0;
        // Restore the delta/full accounting too, or a resumed session would think it owes a full
        // checkpoint immediately and undo the saving on its very first cadence boundary.
        writer.recordCheckpointCost(event, Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8"));
      } else writer.eventsSinceCheckpoint += 1;
      applyFileEvent(writer.projection, event);
    }
    writer.handle = await fs.open(writer.streamPath, "a+");
    return writer;
  }

  get headSeq(): number {
    return this.sequence;
  }

  get currentTime(): number {
    return this.lastTime;
  }

  get currentFiles(): ReadonlyMap<string, string | null> {
    return this.projection.files;
  }

  append<T extends SesEventType>(input: SesEventInput<T>): Promise<AnySesEvent[]> {
    const operation = this.queue.then(() => this.appendNow(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async appendCheckpoint(reason: "cadence" | "final" | "hydration" = "final"): Promise<AnySesEvent[]> {
    return this.append({ type: "checkpoint", payload: { reason, files: checkpointFiles(this.projection) } });
  }

  async flush(): Promise<void> {
    await this.queue;
    await this.handle?.sync();
  }

  async close(): Promise<void> {
    await this.flush();
    await this.handle?.close();
    this.handle = null;
  }

  private async appendNow<T extends SesEventType>(input: SesEventInput<T>): Promise<AnySesEvent[]> {
    const parsed = input as SesEventInput;
    const expectedSeq = this.sequence + 1;
    if (parsed.seq !== undefined && parsed.seq !== expectedSeq) throw new Error(`expected sequence ${expectedSeq}`);
    const timestamp = parsed.t ?? Math.max(this.lastTime, Math.floor(this.clock() - this.sessionStartMs));
    if (!Number.isInteger(timestamp) || timestamp < this.lastTime) throw new Error("timestamp must be nondecreasing");
    const candidate = sesEventSchema.parse({ seq: expectedSeq, t: timestamp, type: parsed.type, payload: parsed.payload }) as AnySesEvent;
    const nextProjection = cloneFileProjection(this.projection);
    applyFileEvent(nextProjection, candidate);
    const bytes = await this.write(candidate);
    this.projection = nextProjection;
    this.sequence = candidate.seq;
    this.lastTime = candidate.t;
    if (isCheckpoint(candidate)) {
      this.recordCheckpointCost(candidate, bytes);
      this.eventsSinceCheckpoint = 0;
      return [candidate];
    }
    this.eventsSinceCheckpoint += 1;
    if (this.eventsSinceCheckpoint < 500) return [candidate];
    const checkpoint = this.buildCadenceCheckpoint();
    this.recordCheckpointCost(checkpoint, await this.write(checkpoint));
    this.projection.pending.clear();
    this.sequence = checkpoint.seq;
    this.lastTime = checkpoint.t;
    this.eventsSinceCheckpoint = 0;
    return [candidate, checkpoint];
  }

  // A full checkpoint restates every file ever touched, so emitting one every 500 events makes a stream
  // grow with the square of its length: a real session reached 1.1 GB of checkpoints across 84 of them.
  // Writing deltas instead, and paying for a full one only once the deltas since the last full have cost
  // as much as that full one did, keeps total checkpoint bytes within about twice the delta volume.
  private buildCadenceCheckpoint(): AnySesEvent {
    const scope: CheckpointScope = this.deltaBytesSinceFull >= this.lastFullCheckpointBytes ? "full" : "delta";
    return sesEventSchema.parse({
      seq: this.sequence + 1,
      t: this.lastTime,
      type: "checkpoint",
      payload: { reason: scope === "full" ? "cadence" : "delta", files: checkpointFiles(this.projection, scope) }
    }) as AnySesEvent;
  }

  private recordCheckpointCost(event: AnySesEvent, bytes: number): void {
    if (event.type !== "checkpoint") return;
    if (event.payload.reason === "delta") this.deltaBytesSinceFull += bytes;
    else {
      this.lastFullCheckpointBytes = bytes;
      this.deltaBytesSinceFull = 0;
    }
  }

  private async write(event: AnySesEvent): Promise<number> {
    if (this.handle === null) throw new Error("writer is closed");
    const line = `${JSON.stringify(event)}\n`;
    const buffer = Buffer.from(line, "utf8");
    await this.handle.write(buffer);
    return buffer.byteLength;
  }
}
