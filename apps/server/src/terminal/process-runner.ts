import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { resolveWorkspacePath, type WorkspaceRoot } from "@theaihatch/workspace";

export const processRequestSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).default("."),
  shell: z.string().min(1).optional()
}).strict();

export type ProcessRequest = z.input<typeof processRequestSchema>;
export type TerminalOutputStream = "stdout" | "stderr";

export interface ProcessChunk {
  stream: TerminalOutputStream;
  chunk: string;
}

export type ProcessOutcome = "running" | "exited" | "cancelled" | "failed";

export interface ProcessResult {
  status: Exclude<ProcessOutcome, "running">;
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

export interface ProcessHandle {
  readonly pid: number | undefined;
  readonly result: Promise<ProcessResult>;
  cancel(): void;
}

export interface ProcessRunnerOptions {
  onChunk?: (chunk: ProcessChunk) => void | Promise<void>;
  signal?: AbortSignal;
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/sh";
}

function decodeStream(child: ChildProcess, stream: NodeJS.ReadableStream | null, channel: TerminalOutputStream, onChunk: (chunk: ProcessChunk) => void | Promise<void>): void {
  if (stream === null) return;
  const decoder = new StringDecoder("utf8");
  stream.on("data", (value: Buffer | string) => {
    const text = decoder.write(typeof value === "string" ? Buffer.from(value) : value);
    if (text !== "") void onChunk({ stream: channel, chunk: text });
  });
  stream.on("end", () => {
    const text = decoder.end();
    if (text !== "") void onChunk({ stream: channel, chunk: text });
  });
  void child;
}

export class ProcessRunner {
  constructor(private readonly root: WorkspaceRoot) {}

  start(input: ProcessRequest, options: ProcessRunnerOptions = {}): ProcessHandle {
    const request = processRequestSchema.parse(input);
    const cwd = resolveWorkspacePath(this.root, request.cwd);
    const shell = request.shell ?? defaultShell();
    let cancelled = false;
    let settled = false;
    let child: ChildProcess;
    let resolveResult!: (result: ProcessResult) => void;
    const result = new Promise<ProcessResult>((resolve) => { resolveResult = resolve; });
    const finish = (value: ProcessResult): void => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };

    try {
      child = spawn(request.command, { cwd, shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ status: "failed", exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) });
      return { pid: undefined, result, cancel: () => undefined };
    }

    decodeStream(child, child.stdout, "stdout", options.onChunk ?? (() => undefined));
    decodeStream(child, child.stderr, "stderr", options.onChunk ?? (() => undefined));
    const abort = (): void => {
      cancelled = true;
      child.kill();
    };
    if (options.signal?.aborted === true) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => finish({ status: cancelled ? "cancelled" : "failed", exitCode: null, signal: null, error: error.message }));
    child.once("close", (exitCode, signal) => {
      options.signal?.removeEventListener("abort", abort);
      const status = cancelled ? "cancelled" : exitCode === 0 ? "exited" : "failed";
      finish({ status, exitCode, signal });
    });
    return { pid: child.pid, result, cancel: abort };
  }

  run(input: ProcessRequest, options: ProcessRunnerOptions = {}): Promise<ProcessResult> {
    return this.start(input, options).result;
  }
}
