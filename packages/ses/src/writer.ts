import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AnySesEvent, SesEventInput, SesEventType } from "./schema.js";
import { isCheckpoint, sesEventSchema } from "./schema.js";
import { applyFileEvent, checkpointFiles, cloneFileProjection, createFileProjection, type FileProjectionState } from "./checkpoints.js";
import { SesReader } from "./reader.js";

export interface SesWriterOptions {
  clock?: () => number;
  sessionStartMs?: number;
}

function ensureSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(sessionId)) throw new Error("invalid session identifier");
}

export function sessionDirectory(dataDir: string, sessionId: string): string {
  ensureSafeSessionId(sessionId);
  return path.resolve(dataDir, "sessions", sessionId);
}

export class SesWriter {
  private readonly streamPath: string;
  private readonly clock: () => number;
  private readonly sessionStartMs: number;
  private handle: FileHandle | null = null;
  private sequence = -1;
  private lastTime = 0;
  private eventsSinceCheckpoint = 0;
  private projection: FileProjectionState = createFileProjection();
  private queue: Promise<void> = Promise.resolve();

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
      if (isCheckpoint(event)) writer.eventsSinceCheckpoint = 0;
      else writer.eventsSinceCheckpoint += 1;
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

  async appendCheckpoint(reason: "cadence" | "final" = "final"): Promise<AnySesEvent[]> {
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
    await this.write(candidate);
    this.projection = nextProjection;
    this.sequence = candidate.seq;
    this.lastTime = candidate.t;
    if (isCheckpoint(candidate)) {
      this.eventsSinceCheckpoint = 0;
      return [candidate];
    }
    this.eventsSinceCheckpoint += 1;
    if (this.eventsSinceCheckpoint < 500) return [candidate];
    const checkpoint = sesEventSchema.parse({
      seq: this.sequence + 1,
      t: this.lastTime,
      type: "checkpoint",
      payload: { reason: "cadence", files: checkpointFiles(this.projection) }
    }) as AnySesEvent;
    await this.write(checkpoint);
    this.sequence = checkpoint.seq;
    this.lastTime = checkpoint.t;
    this.eventsSinceCheckpoint = 0;
    return [candidate, checkpoint];
  }

  private async write(event: AnySesEvent): Promise<void> {
    if (this.handle === null) throw new Error("writer is closed");
    const line = `${JSON.stringify(event)}\n`;
    await this.handle.write(Buffer.from(line, "utf8"));
  }
}
