import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { initializeFirstRun } from "../src/bootstrap/first-run.js";
import { initializeStorage } from "../src/bootstrap/storage.js";
import { listenLoopback, openBrowser, waitForReadiness } from "../src/bootstrap/listen.js";
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

  it("REQ-PKG-003: binds the first available fallback with the real app", async () => {
    const occupied = Fastify();
    const app = Fastify();

    try {
      await occupied.listen({ host: "127.0.0.1", port: 0 });
      const address = occupied.server.address();
      const preferred = typeof address === "object" && address !== null ? address.port : 0;

      const selected = await listenLoopback(app, { preferredPort: preferred, fallbackCount: 20 });

      expect(selected).not.toBe(preferred);
      expect(app.server.listening).toBe(true);
      expect(app.server.address()).toMatchObject({ port: selected });
    } finally {
      await app.close();
      await occupied.close();
    }
  });

  it("REQ-PKG-003: reports exhaustion when the bounded fallback range is occupied", async () => {
    const occupied = Fastify();
    const app = Fastify();

    try {
      await occupied.listen({ host: "127.0.0.1", port: 0 });
      const address = occupied.server.address();
      const preferred = typeof address === "object" && address !== null ? address.port : 0;

      await expect(listenLoopback(app, { preferredPort: preferred, fallbackCount: 0 })).rejects.toThrow(/loopback port/i);
    } finally {
      await app.close();
      await occupied.close();
    }
  });

  it("polls the health route until it returns a successful response", async () => {
    const requested: string[] = [];
    let attempts = 0;
    const fetcher: typeof fetch = async (input) => {
      requested.push(String(input));
      attempts += 1;
      return new Response(undefined, { status: attempts === 1 ? 503 : 200 });
    };

    await waitForReadiness("http://127.0.0.1:4317", { timeoutMs: 100, intervalMs: 0, fetcher });

    expect(requested).toEqual([
      "http://127.0.0.1:4317/health",
      "http://127.0.0.1:4317/health",
    ]);
  });

  it("times out when the health route never becomes ready", async () => {
    const fetcher: typeof fetch = async () => new Response(undefined, { status: 503 });

    await expect(waitForReadiness("http://127.0.0.1:4317", { timeoutMs: 5, intervalMs: 1, fetcher })).rejects.toThrow(/timed out/i);
  });

  it.each([
    ["win32", "cmd", ["/c", "start", "", "http://127.0.0.1:4317"]],
    ["darwin", "open", ["http://127.0.0.1:4317"]],
    ["linux", "xdg-open", ["http://127.0.0.1:4317"]],
  ] as const)("opens the exact URL with the %s platform command", async (platform, expectedFile, expectedArgs) => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];

    await openBrowser("http://127.0.0.1:4317", platform, async (file, args) => {
      calls.push({ file, args });
    });

    expect(calls).toEqual([{ file: expectedFile, args: expectedArgs }]);
  });

  it("REQ-PKG-006: rate-limits update checks", () => {
    const checker = new UpdateChecker(100);
    expect(checker.shouldCheck(0)).toBe(true);
    expect(checker.shouldCheck(1000)).toBe(true);
    checker.markChecked(1000);
    expect(checker.shouldCheck(1050)).toBe(false);
    expect(checker.shouldCheck(1100)).toBe(true);
  });
});
