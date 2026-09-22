import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SesReader, SesWriter } from "@theaihatch/ses";
import { registerWorkspaceRoutes, WorkspaceRegistry } from "../src/routes/workspaces.js";
import { ProcessRunner } from "../src/terminal/process-runner.js";
import { TerminalRecorder } from "../src/terminal/terminal-recorder.js";
import { openWorkspaceRoot } from "@theaihatch/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

// Without an explicit data directory the registry writes session streams into the real user data
// directory, so every test run left an orphaned session behind on the developer's machine.
async function dataDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-server-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-server-"));
  temporaryDirectories.push(root);
  await fs.writeFile(path.join(root, "README.md"), "hello\n", "utf8");
  return root;
}

describe("workspace HTTP routes", () => {
  it("REQ-WKS-001 and REQ-WKS-002: opens a handle and reads a stable tree/file", async () => {
    const app = Fastify();
    registerWorkspaceRoutes(app, new WorkspaceRegistry(undefined, await dataDirectory()));
    const root = await fixture();
    const opened = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: root } });
    expect(opened.statusCode).toBe(200);
    const handle = (opened.json() as { id: string }).id;
    const tree = await app.inject({ method: "GET", url: `/api/workspaces/${handle}/tree` });
    expect(tree.json()).toEqual({ entries: [{ name: "README.md", path: "README.md", kind: "file" }] });
    const file = await app.inject({ method: "GET", url: `/api/workspaces/${handle}/file?path=README.md` });
    expect(file.json()).toEqual({ path: "README.md", content: "hello\n" });
    const saved = await app.inject({ method: "PUT", url: `/api/workspaces/${handle}/file`, payload: { path: "README.md", content: "saved\n" } });
    expect(saved.statusCode).toBe(200);
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("saved\n");
    await app.close();
  });

  it("REQ-WKS-003, REQ-TRM-001, and REQ-TRM-005: runs the provider-free workspace demo as replayable SES", async () => {
    const app = Fastify();
    registerWorkspaceRoutes(app, new WorkspaceRegistry(undefined, await dataDirectory()));
    const root = await fixture();
    const opened = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: root } });
    const handle = (opened.json() as { id: string }).id;
    const demo = await app.inject({ method: "POST", url: `/api/workspaces/${handle}/demo` });
    expect(demo.statusCode).toBe(200);
    const events = (demo.json() as { events: Array<{ type: string }> }).events;
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["file_create", "edit_insert", "terminal_command", "terminal_output", "checkpoint"]));
    expect(await fs.readFile(path.join(root, "theaihatch-demo", "hello.ts"), "utf8")).toContain("greeting");
    await app.close();
  });
});

describe("terminal recording", () => {
  it("REQ-TRM-001, REQ-TRM-003, and REQ-TRM-004: records ordered stdout/stderr and exit outcome", async () => {
    const root = await fixture();
    const opened = await openWorkspaceRoot(root);
    const session = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-session-"));
    temporaryDirectories.push(session);
    const writer = await SesWriter.open(session, { clock: () => 1000, sessionStartMs: 1000 });
    const executable = process.platform === "win32" ? `"${process.execPath}"` : process.execPath;
    const command = `${executable} -e "process.stdout.write('out'); process.stderr.write('err'); process.exit(2)"`;
    const result = await new TerminalRecorder(writer, new ProcessRunner(opened)).run({ command });
    await writer.close();
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(2);
    const reader = await SesReader.open(path.join(session, "events.jsonl"));
    const events = (await reader.readRange(0, reader.headSeq)).events;
    expect(events.map((event) => event.type)).toEqual(["terminal_command", "terminal_output", "terminal_output", "terminal_output"]);
    expect(events.filter((event) => event.type === "terminal_output").map((event) => event.payload.chunk)).toEqual(expect.arrayContaining(["out", "err", ""]));
  });

  it("REQ-TRM-002: command entry is represented before output", async () => {
    const root = await fixture();
    const opened = await openWorkspaceRoot(root);
    const session = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-session-"));
    temporaryDirectories.push(session);
    const writer = await SesWriter.open(session, { clock: () => 1000, sessionStartMs: 1000 });
    const executable = process.platform === "win32" ? `"${process.execPath}"` : process.execPath;
    await new TerminalRecorder(writer, new ProcessRunner(opened)).run({ command: `${executable} -e "console.log('ok')"` });
    await writer.close();
    const reader = await SesReader.open(path.join(session, "events.jsonl"));
    const events = (await reader.readRange(0, reader.headSeq)).events;
    expect(events[0]?.type).toBe("terminal_command");
  });
});
