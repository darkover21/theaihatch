import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeFirstRun } from "../src/bootstrap/first-run.js";
import { findLoopbackPort } from "../src/bootstrap/listen.js";
import { UpdateChecker } from "../src/updates/check.js";
describe("bootstrap", () => { it("REQ-PKG-002: resumes initialized first-run state", async () => { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-first-run-")); const first = await initializeFirstRun(directory); const second = await initializeFirstRun(directory, async () => { throw new Error("should not recheck"); }); expect(first).toEqual(second); }); it("REQ-PKG-003: chooses an available loopback port", async () => { const port = await findLoopbackPort(0, 1); expect(port).toBeGreaterThan(0); }); it("REQ-PKG-006: rate-limits update checks", () => { const checker = new UpdateChecker(100); expect(checker.shouldCheck(1000)).toBe(true); checker.markChecked(1000); expect(checker.shouldCheck(1050)).toBe(false); expect(checker.shouldCheck(1100)).toBe(true); }); });
