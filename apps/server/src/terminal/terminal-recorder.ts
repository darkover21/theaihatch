import { randomUUID } from "node:crypto";
import type { SesWriter } from "../ses.js";
import { ProcessRunner, type ProcessResult } from "./process-runner.js";

export interface RecordedCommand {
  command: string;
  cwd?: string;
  shell?: string;
  commandId?: string;
  signal?: AbortSignal;
}

export class TerminalRecorder {
  constructor(private readonly writer: SesWriter, private readonly runner: ProcessRunner) {}

  async run(input: RecordedCommand): Promise<ProcessResult> {
    const commandId = input.commandId ?? randomUUID();
    const cwd = input.cwd ?? ".";
    const shell = input.shell ?? (process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.env.SHELL ?? "/bin/sh");
    await this.writer.append({ type: "terminal_command", payload: { commandId, command: input.command, cwd, shell } });
    let writes = Promise.resolve();
    const handle = this.runner.start({ command: input.command, cwd, shell }, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onChunk: (chunk) => {
        writes = writes.then(async () => {
          await this.writer.append({ type: "terminal_output", payload: { commandId, stream: chunk.stream, chunk: chunk.chunk, eof: false } });
        });
        return writes;
      }
    });
    const result = await handle.result;
    await writes;
    await this.writer.append({
      type: "terminal_output",
      payload: {
        commandId,
        stream: "stdout",
        chunk: "",
        eof: true,
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(result.signal === null ? {} : { signal: result.signal })
      }
    });
    return result;
  }
}
