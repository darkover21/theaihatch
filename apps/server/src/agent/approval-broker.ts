import type { ReviewHunk } from "@theaihatch/review";
import type { StoredReviewDecisionInput } from "@theaihatch/storage";
import type { CommandDecision } from "@theaihatch/safety";

export type PendingApproval =
  | { kind: "review"; operationId: string; snapshotId: string; hunks: ReviewHunk[] }
  | { kind: "command"; operationId: string; decision: CommandDecision };

interface PendingRequest<T> {
  approval: PendingApproval;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

export class ApprovalBroker {
  private readonly requests = new Map<string, PendingRequest<unknown>>();

  requestReview(input: Omit<Extract<PendingApproval, { kind: "review" }>, "kind">): Promise<StoredReviewDecisionInput[]> {
    return this.request({ kind: "review", ...input });
  }

  requestCommand(input: Omit<Extract<PendingApproval, { kind: "command" }>, "kind">): Promise<{ approved: boolean }> {
    return this.request({ kind: "command", ...input });
  }

  pending(operationId: string): PendingApproval | null {
    return this.requests.get(operationId)?.approval ?? null;
  }

  resolveReview(operationId: string, decisions: readonly StoredReviewDecisionInput[]): void {
    const request = this.requests.get(operationId);
    if (request === undefined || request.approval.kind !== "review") throw new Error(`review approval not pending: ${operationId}`);
    const expectedHunkIds = new Set(request.approval.hunks.map((hunk) => hunk.id));
    const decisionHunkIds = new Set(decisions.map((decision) => decision.hunkId));
    if (decisions.length !== request.approval.hunks.length || decisionHunkIds.size !== decisions.length || [...decisionHunkIds].some((hunkId) => !expectedHunkIds.has(hunkId))) throw new Error(`review must include exactly one decision per hunk: ${operationId}`);
    this.requests.delete(operationId);
    request.resolve([...decisions]);
  }

  resolveCommand(operationId: string, input: { approved: boolean; command: string; cwd: string }): void {
    const request = this.requests.get(operationId);
    if (request === undefined || request.approval.kind !== "command") throw new Error(`command approval not pending: ${operationId}`);
    if (input.command !== request.approval.decision.exactCommand || input.cwd !== request.approval.decision.cwd) throw new Error(`command approval does not match pending command: ${operationId}`);
    this.requests.delete(operationId);
    request.resolve({ approved: input.approved });
  }

  cancel(operationId: string, reason: string): void {
    const request = this.requests.get(operationId);
    if (request === undefined) return;
    this.requests.delete(operationId);
    request.reject(new Error(reason));
  }

  private request<T>(approval: PendingApproval): Promise<T> {
    if (this.requests.has(approval.operationId)) throw new Error(`approval already pending: ${approval.operationId}`);
    let resolveRequest!: (value: T) => void;
    let rejectRequest!: (reason: Error) => void;
    const promise = new Promise<T>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    this.requests.set(approval.operationId, { approval, resolve: resolveRequest as (value: unknown) => void, reject: rejectRequest });
    return promise;
  }
}
