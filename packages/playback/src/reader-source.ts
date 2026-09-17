import type { AnySesEvent, WorkspacePath } from "@theaihatch/ses";
import { SesReader } from "@theaihatch/ses";
import type { EventSource } from "./source.js";

export class ReaderEventSource implements EventSource {
  readonly live: boolean;
  constructor(private readonly reader: SesReader, live = false) {
    this.live = live;
  }

  getHeadSeq(): number { return this.reader.headSeq; }
  async readRange(fromSeq: number, toSeq: number): Promise<{ events: AnySesEvent[]; headSeq: number }> {
    const range = await this.reader.readRange(fromSeq, toSeq);
    return { events: range.events, headSeq: range.headSeq };
  }
  getCheckpointAtOrBefore(targetSeq: number): AnySesEvent | null { return this.reader.getCheckpointAtOrBefore(targetSeq); }
  getFileOccurrences(path: WorkspacePath): Array<{ seq: number; type: AnySesEvent["type"] }> { return this.reader.getFileOccurrences(path); }
  subscribe(_listener: () => void): () => void { return () => undefined; }
}
