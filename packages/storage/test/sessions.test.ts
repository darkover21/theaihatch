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

async function repositoryIn(label: string): Promise<SessionRepository> {
  return new SessionRepository(await fs.mkdtemp(path.join(os.tmpdir(), `theaihatch-storage-${label}-`)));
}

it("finds the session a workspace folder should resume into", async () => {
  const repository = await repositoryIn("lookup");
  try {
    repository.create({ id: "session-alpha-1", workspacePath: "/work/alpha" });
    repository.create({ id: "session-beta", workspacePath: "/work/beta" });
    const newest = repository.create({ id: "session-alpha-2", workspacePath: "/work/alpha" });

    expect(repository.findLatestByWorkspacePath("/work/alpha")?.id).toBe(newest.id);
    expect(repository.findLatestByWorkspacePath("/work/beta")?.id).toBe("session-beta");
    expect(repository.findLatestByWorkspacePath("/work/unknown")).toBeNull();
    // A folder whose path is a prefix of another must not match it.
    expect(repository.findLatestByWorkspacePath("/work/alph")).toBeNull();
  } finally {
    repository.close();
  }
});

it("records session start once and end on demand", async () => {
  const repository = await repositoryIn("lifecycle");
  try {
    const id = "session-gamma";
    repository.create({ id, workspacePath: "/work/gamma" });
    expect(repository.get(id).status).toBe("created");

    repository.markStarted(id);
    const started = repository.get(id).startedAt;
    expect(started).not.toBeNull();
    expect(repository.get(id).status).toBe("running");

    // Resuming the same session must not rewrite when it first recorded anything.
    repository.markStarted(id);
    expect(repository.get(id).startedAt).toBe(started);

    repository.markEnded(id, "completed");
    expect(repository.get(id).status).toBe("completed");
    expect(repository.get(id).endedAt).not.toBeNull();
    expect(repository.get(id).startedAt).toBe(started);
  } finally {
    repository.close();
  }
});
