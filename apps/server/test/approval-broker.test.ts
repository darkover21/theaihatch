import { describe, expect, it } from "vitest";
import type { ReviewHunk } from "@theaihatch/review";
import type { StoredReviewDecisionInput } from "@theaihatch/storage";
import type { CommandDecision } from "@theaihatch/safety";
import { ApprovalBroker } from "../src/agent/approval-broker.js";

const hunks: ReviewHunk[] = [{ id: "hunk-1", path: "a.ts", startLine: 1, beforeLines: ["before"], afterLines: ["after"], fingerprint: "fingerprint-1" }];
const decisions: StoredReviewDecisionInput[] = [{ hunkId: "hunk-1", decision: "rejected", actor: "user", feedback: "Please revise" }];
const multiHunks: ReviewHunk[] = [
  ...hunks,
  { id: "hunk-2", path: "a.ts", startLine: 3, beforeLines: ["old"], afterLines: ["new"], fingerprint: "fingerprint-2" }
];
const decisionFor = (hunkId: string): StoredReviewDecisionInput => ({ hunkId, decision: "accepted", actor: "user" });
const decision: CommandDecision = { destructive: true, reason: "command may delete, overwrite, or terminate resources", exactCommand: "rm a.ts", cwd: "/workspace" };

describe("approval broker", () => {
  it("REQ-REV-003: waits until every current hunk is resolved", async () => {
    const broker = new ApprovalBroker();
    const wait = broker.requestReview({ operationId: "run-1", snapshotId: "snapshot-1", hunks });
    expect(broker.pending("run-1")?.kind).toBe("review");
    broker.resolveReview("run-1", decisions);
    await expect(wait).resolves.toEqual(decisions);
  });

  it("REQ-REV-003: rejects an incomplete multi-hunk decision set and keeps the review pending", () => {
    const broker = new ApprovalBroker();
    broker.requestReview({ operationId: "run-1", snapshotId: "snapshot-1", hunks: multiHunks });
    expect(() => broker.resolveReview("run-1", [decisionFor("hunk-1")])).toThrow("one decision per hunk");
    expect(broker.pending("run-1")?.kind).toBe("review");
  });

  it("REQ-REV-003: rejects an unknown hunk ID and keeps the review pending", () => {
    const broker = new ApprovalBroker();
    broker.requestReview({ operationId: "run-1", snapshotId: "snapshot-1", hunks: multiHunks });
    expect(() => broker.resolveReview("run-1", [decisionFor("hunk-1"), decisionFor("unknown")])).toThrow("one decision per hunk");
    expect(broker.pending("run-1")?.kind).toBe("review");
  });

  it("REQ-REV-003: rejects duplicate hunk decisions and keeps the review pending", () => {
    const broker = new ApprovalBroker();
    broker.requestReview({ operationId: "run-1", snapshotId: "snapshot-1", hunks: multiHunks });
    expect(() => broker.resolveReview("run-1", [decisionFor("hunk-1"), decisionFor("hunk-1")])).toThrow("one decision per hunk");
    expect(broker.pending("run-1")?.kind).toBe("review");
  });

  it("REQ-REV-003: rejects an empty decision set and keeps the review pending", () => {
    const broker = new ApprovalBroker();
    broker.requestReview({ operationId: "run-1", snapshotId: "snapshot-1", hunks: multiHunks });
    expect(() => broker.resolveReview("run-1", [])).toThrow("one decision per hunk");
    expect(broker.pending("run-1")?.kind).toBe("review");
  });

  it("REQ-REV-003: resolves a complete one-to-one multi-hunk decision set", async () => {
    const broker = new ApprovalBroker();
    const wait = broker.requestReview({ operationId: "run-1", snapshotId: "snapshot-1", hunks: multiHunks });
    const complete = [decisionFor("hunk-1"), decisionFor("hunk-2")];
    broker.resolveReview("run-1", complete);
    await expect(wait).resolves.toEqual(complete);
    expect(broker.pending("run-1")).toBeNull();
  });

  it("REQ-SAF-004: a denied exact command resolves to denial without a process", async () => {
    const broker = new ApprovalBroker();
    const wait = broker.requestCommand({ operationId: "run-1", decision });
    broker.resolveCommand("run-1", { command: decision.exactCommand, cwd: decision.cwd, approved: false });
    await expect(wait).resolves.toMatchObject({ approved: false });
  });

  it("cancels a pending approval and clears its operation", async () => {
    const broker = new ApprovalBroker();
    const wait = broker.requestCommand({ operationId: "run-1", decision });
    broker.cancel("run-1", "run cancelled");
    await expect(wait).rejects.toThrow("run cancelled");
    expect(broker.pending("run-1")).toBeNull();
  });
});
