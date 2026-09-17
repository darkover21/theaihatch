import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRepository } from "../src/index.js";

describe("session metadata", () => {
  it("REQ-SES-008: persists session summary without scanning JSONL", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-storage-"));
    const repository = new SessionRepository(dataDir);
    const created = repository.create({ id: "demo", workspacePath: "workspace" });
    repository.updateProgress(created.id, 17, 190, "valid");
    const listed = repository.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.headSeq).toBe(17);
    expect(listed[0]?.durationMs).toBe(190);
    await expect(fs.stat(path.join(dataDir, "sessions", "demo", "index.sqlite"))).resolves.toBeTruthy();
    repository.close();
  });
});
