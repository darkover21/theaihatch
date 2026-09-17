export interface ReviewFeedback { path: string; hunkId?: string; decision: "accepted" | "rejected"; feedback?: string; }
export class ReviewGate {
  private pending: ReviewFeedback[] = [];
  private nextFeedback: ReviewFeedback[] = [];
  private waiter: (() => void) | null = null;
  require(feedback: ReviewFeedback[]): void { this.pending = [...feedback]; }
  isBlocked(): boolean { return this.pending.length > 0; }
  resolve(feedback: ReviewFeedback[]): void { this.nextFeedback.push(...feedback); this.pending = []; this.waiter?.(); this.waiter = null; }
  consumeFeedback(): ReviewFeedback[] { const result = [...this.nextFeedback]; this.nextFeedback = []; return result; }
  async wait(signal?: AbortSignal): Promise<void> {
    if (!this.isBlocked()) return;
    if (signal?.aborted === true) throw new Error("run cancelled");
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { this.waiter = null; reject(new Error("run cancelled")); };
      this.waiter = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
