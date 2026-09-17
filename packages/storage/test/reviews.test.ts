import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffFile } from "@theaihatch/review";
import { ReviewRepository, SafetyAuditRepository } from "../src/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

async function createDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-review-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("review persistence", () => {
  it("REQ-REV-006: returns frozen hunk content after workspace bytes change", async () => {
    const directory = await createDirectory();
    const repository = new ReviewRepository(directory);
    const fileDiff = diffFile("src/api.ts", "original", "proposed");

    const snapshot = repository.createSnapshot({ runId: "run-1", checkpointId: "cp-1", files: [fileDiff] });
    fileDiff.after = "workspace changed";
    fileDiff.hunks[0]!.afterLines[0] = "workspace changed";
    repository.resolveSnapshot(snapshot.id, [{ hunkId: fileDiff.hunks[0]!.id, decision: "rejected", actor: "local", feedback: "keep API" }]);

    expect(repository.listSnapshots("run-1")[0]?.files[0]?.after).toBe("proposed");
    repository.close();
  });

  it("persists snapshots, decisions, and checkpoint identity across repository reload", async () => {
    const directory = await createDirectory();
    const repository = new ReviewRepository(directory);
    const fileDiff = diffFile("README.md", "before", "after");
    const snapshot = repository.createSnapshot({ runId: "run-1", checkpointId: "cp-1", files: [fileDiff] });
    repository.resolveSnapshot(snapshot.id, [{ hunkId: fileDiff.hunks[0]!.id, decision: "accepted", actor: "reviewer", feedback: "looks good", timestamp: "2026-09-17T00:00:00.000Z" }]);
    repository.recordCheckpoint({ runId: "run-1", checkpointId: "cp-2", kind: "recovery", createdAt: "2026-09-17T00:01:00.000Z" });
    repository.close();

    const reloaded = new ReviewRepository(directory);
    expect(reloaded.listSnapshots("run-1")).toEqual([{ ...snapshot, decisions: [{ hunkId: fileDiff.hunks[0]!.id, decision: "accepted", actor: "reviewer", feedback: "looks good", timestamp: "2026-09-17T00:00:00.000Z" }] }]);
    reloaded.close();
  });
});

describe("safety audit persistence", () => {
  it("REQ-SAF-007: redacts configured secret values", async () => {
    const directory = await createDirectory();
    const audit = new SafetyAuditRepository(directory, ["secret-value"]);

    audit.record({ runId: "run-1", action: "path", decision: "denied", detail: JSON.stringify({ key: "secret-value" }) });

    expect(audit.list("run-1")[0]?.detail).not.toContain("secret-value");
    audit.close();
  });

  it("redacts configured values that require JSON escaping", async () => {
    const directory = await createDirectory();
    const secret = "line\n\"quoted\"\\path";
    const audit = new SafetyAuditRepository(directory, [secret]);

    audit.record({ runId: "run-1", action: "provider", decision: "denied", detail: JSON.stringify({ credential: secret }) });

    const detail = audit.list("run-1")[0]?.detail ?? "{}";
    audit.close();
    expect(JSON.parse(detail)).toEqual({ credential: "[REDACTED]" });
  });

  it("redacts sensitive JSON keys even when their values are not configured", async () => {
    const directory = await createDirectory();
    const audit = new SafetyAuditRepository(directory);

    audit.record({ runId: "run-1", action: "command", decision: "denied", detail: JSON.stringify({ apiKey: "one", token: "two", nested: { authorization: "three" } }) });

    const detail = audit.list("run-1")[0]?.detail ?? "";
    expect(detail).not.toContain("one");
    expect(detail).not.toContain("two");
    expect(detail).not.toContain("three");
    audit.close();
  });
});
