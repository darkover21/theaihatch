export interface ChangeCursorResult<T> { entries: readonly T[]; cursor: number; dropped: boolean; }

export class ChangeLog<T> {
  private readonly entries: Array<{ seq: number; value: T }> = [];
  private nextSeq = 0;
  private dropped = false;
  constructor(private readonly capacity = 1000) {}

  append(value: T): number {
    const seq = this.nextSeq++;
    this.entries.push({ seq, value });
    if (this.entries.length > this.capacity) { this.entries.shift(); this.dropped = true; }
    return seq;
  }

  since(cursor: number): ChangeCursorResult<T> {
    const first = this.entries[0]?.seq ?? this.nextSeq;
    return { entries: this.entries.filter((entry) => entry.seq > cursor).map((entry) => entry.value), cursor: this.nextSeq - 1, dropped: this.dropped && cursor < first - 1 };
  }
}
