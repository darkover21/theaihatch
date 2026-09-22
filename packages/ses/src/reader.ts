import { promises as fs } from "node:fs";
import path from "node:path";
import type { AnySesEvent, WorkspacePath } from "./schema.js";
import { isFullCheckpoint, validateSesEvent } from "./schema.js";

export type IntegrityStatus = "valid" | "recovered" | "corrupt";

export interface EventRange {
  events: AnySesEvent[];
  headSeq: number;
  integrity: IntegrityStatus;
}

export interface EventIndexEntry {
  seq: number;
  t: number;
  type: AnySesEvent["type"];
  start: number;
  end: number;
}

export interface SeekWindow {
  checkpoint: AnySesEvent | null;
  events: AnySesEvent[];
  targetSeq: number;
}

export interface SesReaderOptions {
  recoveryPath?: string;
}

export class SesReader {
  readonly streamPath: string;
  readonly recoveryPath: string;
  readonly integrity: IntegrityStatus;
  private readonly bytes: Buffer;
  private readonly entries: EventIndexEntry[];
  private readonly eventsBySeq: Map<number, AnySesEvent>;

  private constructor(streamPath: string, recoveryPath: string, bytes: Buffer, entries: EventIndexEntry[], eventsBySeq: Map<number, AnySesEvent>, integrity: IntegrityStatus) {
    this.streamPath = streamPath;
    this.recoveryPath = recoveryPath;
    this.bytes = bytes;
    this.entries = entries;
    this.eventsBySeq = eventsBySeq;
    this.integrity = integrity;
  }

  static async open(streamPath: string, options: SesReaderOptions = {}): Promise<SesReader> {
    const resolvedStreamPath = path.resolve(streamPath);
    const recoveryPath = path.resolve(options.recoveryPath ?? path.join(path.dirname(resolvedStreamPath), "recovery.jsonl"));
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(resolvedStreamPath);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
      if (code !== "ENOENT") throw error;
      bytes = Buffer.alloc(0);
    }

    const entries: EventIndexEntry[] = [];
    const eventsBySeq = new Map<number, AnySesEvent>();
    let integrity: IntegrityStatus = "valid";
    let cursor = 0;
    let expectedSeq = 0;
    let lastTime = 0;
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(10, cursor);
      const end = newline === -1 ? bytes.length : newline;
      const raw = bytes.subarray(cursor, end);
      const isFinalLine = end === bytes.length;
      if (raw.length === 0) {
        integrity = "corrupt";
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as unknown;
      } catch {
        if (isFinalLine) {
          await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
          await fs.appendFile(recoveryPath, Buffer.concat([raw, Buffer.from("\n", "utf8")]));
          integrity = "recovered";
        } else {
          integrity = "corrupt";
        }
        break;
      }
      let validated: AnySesEvent;
      try {
        validated = validateSesEvent(parsed);
      } catch {
        integrity = "corrupt";
        break;
      }
      if (validated.seq !== expectedSeq || validated.t < lastTime) {
        integrity = "corrupt";
        break;
      }
      entries.push({ seq: validated.seq, t: validated.t, type: validated.type, start: cursor, end });
      eventsBySeq.set(validated.seq, validated);
      expectedSeq += 1;
      lastTime = validated.t;
      cursor = newline === -1 ? bytes.length : newline + 1;
    }
    return new SesReader(resolvedStreamPath, recoveryPath, bytes, entries, eventsBySeq, integrity);
  }

  get headSeq(): number {
    return this.entries.length === 0 ? -1 : this.entries[this.entries.length - 1]?.seq ?? -1;
  }

  get index(): readonly EventIndexEntry[] {
    return this.entries;
  }

  async readRange(fromSeq: number, toSeq: number): Promise<EventRange> {
    if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq)) throw new Error("sequence bounds must be integers");
    if (fromSeq > toSeq || toSeq < 0 || this.headSeq < 0) return { events: [], headSeq: this.headSeq, integrity: this.integrity };
    const start = Math.max(0, fromSeq);
    const end = Math.min(this.headSeq, toSeq);
    const events: AnySesEvent[] = [];
    for (let seq = start; seq <= end; seq += 1) {
      const event = this.eventsBySeq.get(seq);
      if (event !== undefined) events.push(event);
    }
    return { events, headSeq: this.headSeq, integrity: this.integrity };
  }

  getEvent(seq: number): AnySesEvent | undefined {
    return this.eventsBySeq.get(seq);
  }

  // Only a full checkpoint can seed a restore. A "delta" one restates just the files touched since the
  // previous checkpoint, so seeking to it would silently drop every file it left out.
  getCheckpointAtOrBefore(targetSeq: number): AnySesEvent | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry === undefined || entry.seq > targetSeq || entry.type !== "checkpoint") continue;
      const event = this.eventsBySeq.get(entry.seq);
      if (event !== undefined && isFullCheckpoint(event)) return event;
    }
    return null;
  }

  async seekWindow(targetSeq: number): Promise<SeekWindow> {
    const target = Math.max(-1, Math.min(targetSeq, this.headSeq));
    const checkpoint = this.getCheckpointAtOrBefore(target);
    const from = checkpoint === null ? 0 : checkpoint.seq + 1;
    const range = await this.readRange(from, target);
    return { checkpoint, events: range.events, targetSeq: target };
  }

  getFileOccurrences(filePath: WorkspacePath): Array<{ seq: number; type: AnySesEvent["type"] }> {
    return this.entries.flatMap((entry) => {
      const event = this.eventsBySeq.get(entry.seq);
      if (event === undefined) return [];
      const matches = event.type === "file_rename"
        ? event.payload.from === filePath || event.payload.to === filePath
        : "path" in event.payload && event.payload.path === filePath;
      return matches ? [{ seq: event.seq, type: event.type }] : [];
    });
  }
}
