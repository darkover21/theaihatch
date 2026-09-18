import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeFirstRun } from "../src/bootstrap/first-run.js";
import { initializeStorage } from "../src/bootstrap/storage.js";
import { findLoopbackPort } from "../src/bootstrap/listen.js";
import { UpdateChecker } from "../src/updates/check.js";
describe("bootstrap", () => {
  it("initializes the application SQLite boundary without retaining its handle", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-storage-"));

    await initializeStorage(directory);

    expect((await fs.stat(path.join(directory, "sessions.sqlite"))).isFile()).toBe(true);
    await expect(fs.rm(directory, { recursive: true })).resolves.toBeUndefined();
  });

  it("REQ-PKG-002: resumes initialized first-run state", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-first-run-"));
    const first = await initializeFirstRun({ dataDirectory: directory });
    const second = await initializeFirstRun({
      dataDirectory: directory,
      verifyKeychain: async () => { throw new Error("should not recheck"); },
      initializeStorage: async () => { throw new Error("should not reinitialize"); }
    });
    expect(first).toEqual(second);
  });

  it("REQ-PKG-003: chooses an available loopback port", async () => {
    const port = await findLoopbackPort(0, 1);
    expect(port).toBeGreaterThan(0);
  });

  it("REQ-PKG-006: rate-limits update checks", () => {
    const checker = new UpdateChecker(100);
    expect(checker.shouldCheck(1000)).toBe(true);
    checker.markChecked(1000);
    expect(checker.shouldCheck(1050)).toBe(false);
    expect(checker.shouldCheck(1100)).toBe(true);
  });
});
