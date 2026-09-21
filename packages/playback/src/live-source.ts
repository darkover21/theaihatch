import type { AnySesEvent, WorkspacePath } from "@theaihatch/ses/browser";
import { validateSesEvent } from "@theaihatch/ses/browser";
import type { EventSource } from "./source.js";

export class LiveEventSource implements EventSource {
  readonly live = true;
  private readonly events: AnySesEvent[] = [];
  private readonly checkpoints: number[] = [];
  private readonly occurrences = new Map<string, Array<{ seq: number; type: AnySesEvent["type"] }>>();
  private readonly listeners = new Set<() => void>();

  getHeadSeq(): number { return this.events.at(-1)?.seq ?? -1; }

  append(event: AnySesEvent): void {
    const next = validateSesEvent(event);
    if (next.seq !== this.getHeadSeq() + 1) throw new Error("live event sequence is not contiguous");
    if (this.events.at(-1) !== undefined && next.t < this.events.at(-1)!.t) throw new Error("live event time regressed");
    this.events.push(next);
    if (next.type === "checkpoint") this.checkpoints.push(next.seq);
    const paths = next.type === "file_rename" ? [next.payload.from, next.payload.to] : "path" in next.payload ? [next.payload.path] : [];
    for (const path of paths) this.occurrences.set(path, [...(this.occurrences.get(path) ?? []), { seq: next.seq, type: next.type }]);
    for (const listener of this.listeners) listener();
  }

  async readRange(fromSeq: number, toSeq: number): Promise<{ events: AnySesEvent[]; headSeq: number }> {
    return { events: this.events.slice(Math.max(0, fromSeq), toSeq + 1), headSeq: this.getHeadSeq() };
  }

  getCheckpointAtOrBefore(targetSeq: number): AnySesEvent | null {
    const seq = this.checkpoints.filter((candidate) => candidate <= targetSeq).at(-1);
    return seq === undefined ? null : this.events[seq] ?? null;
  }

  getFileOccurrences(path: WorkspacePath): Array<{ seq: number; type: AnySesEvent["type"] }> { return [...(this.occurrences.get(path) ?? [])]; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
