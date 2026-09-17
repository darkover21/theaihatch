import type { AnySesEvent, WorkspacePath } from "@theaihatch/ses/browser";
import { validateSesEvent } from "@theaihatch/ses/browser";

export interface EventSource {
  readonly live: boolean;
  getHeadSeq(): number;
  readRange(fromSeq: number, toSeq: number): Promise<{ events: AnySesEvent[]; headSeq: number }>;
  getCheckpointAtOrBefore(targetSeq: number): AnySesEvent | null;
  getFileOccurrences(path: WorkspacePath): Array<{ seq: number; type: AnySesEvent["type"] }>;
  subscribe(listener: () => void): () => void;
}

export class MemoryEventSource implements EventSource {
  readonly live: boolean;
  private readonly events: AnySesEvent[];
  private readonly listeners = new Set<() => void>();

  constructor(events: readonly AnySesEvent[], live = false) {
    this.events = events.map((event) => validateSesEvent(event));
    this.live = live;
    this.assertContiguous();
  }

  getHeadSeq(): number {
    return this.events.at(-1)?.seq ?? -1;
  }

  async readRange(fromSeq: number, toSeq: number): Promise<{ events: AnySesEvent[]; headSeq: number }> {
    return { events: this.events.filter((event) => event.seq >= fromSeq && event.seq <= toSeq), headSeq: this.getHeadSeq() };
  }

  getCheckpointAtOrBefore(targetSeq: number): AnySesEvent | null {
    return [...this.events].reverse().find((event) => event.seq <= targetSeq && event.type === "checkpoint") ?? null;
  }

  getFileOccurrences(path: WorkspacePath): Array<{ seq: number; type: AnySesEvent["type"] }> {
    return this.events.flatMap((event) => {
      const matches = event.type === "file_rename"
        ? event.payload.from === path || event.payload.to === path
        : "path" in event.payload && event.payload.path === path;
      return matches ? [{ seq: event.seq, type: event.type }] : [];
    });
  }

  append(event: AnySesEvent): void {
    const next = validateSesEvent(event);
    if (next.seq !== this.getHeadSeq() + 1) throw new Error("live event sequence is not contiguous");
    const previous = this.events.at(-1);
    if (previous !== undefined && next.t < previous.t) throw new Error("live event time regressed");
    this.events.push(next);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private assertContiguous(): void {
    let previousTime = 0;
    this.events.forEach((event, index) => {
      if (event.seq !== index || event.t < previousTime) throw new Error("source events are not ordered");
      previousTime = event.t;
    });
  }
}
