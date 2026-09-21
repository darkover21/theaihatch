import { SesWriter, sessionDirectory, type AnySesEvent, type SesAppender, type SesEventInput } from "../ses.js";

export type WorkspaceStreamSubscriber = (event: AnySesEvent) => void;

export class WorkspaceStream implements SesAppender {
  private readonly tail: AnySesEvent[] = [];
  private readonly subscribers = new Set<WorkspaceStreamSubscriber>();
  private openStepId: string | null = null;
  private constructor(private readonly writer: SesWriter) {}

  static async open(dataDirectory: string, sessionId: string): Promise<WorkspaceStream> {
    return new WorkspaceStream(await SesWriter.open(sessionDirectory(dataDirectory, sessionId)));
  }

  get currentFiles(): ReadonlyMap<string, string | null> { return this.writer.currentFiles; }
  get headSeq(): number { return this.writer.headSeq; }

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
      if (this.tail.length > 2000) this.tail.shift();
      for (const subscriber of this.subscribers) subscriber(event);
    }
    return events;
  }

  subscribe(fromSeq: number, subscriber: WorkspaceStreamSubscriber): () => void {
    this.subscribers.add(subscriber);
    for (const event of this.tail) if (event.seq >= fromSeq) subscriber(event);
    return () => this.subscribers.delete(subscriber);
  }

  async close(): Promise<void> {
    if (this.openStepId !== null) {
      await this.append({ type: "step_end", payload: { stepId: this.openStepId, outcome: "succeeded" } });
      this.openStepId = null;
    }
    await this.writer.close();
  }
}
