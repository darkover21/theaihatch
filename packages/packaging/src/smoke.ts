import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const stderrLimit = 16_384;
const shutdownTimeoutMs = 2_000;

export interface SmokeOptions {
  executable: string;
  dataDirectory: string;
  expectedVersion?: string;
  timeoutMs?: number;
}

export interface SmokeResult {
  healthStatus: number;
  rootStatus: number;
  stderr: string;
}

interface CapturedOutput {
  stderr: string;
  stdout: string;
  combinedTail: string;
  readinessTail: string;
  readinessUrl?: string;
  forbiddenFallback: boolean;
  error?: Error;
}

export async function runPackageSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const executable = path.resolve(options.executable);
  const dataDirectory = path.resolve(options.dataDirectory);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Smoke timeoutMs must be a positive integer");
  await requireExecutable(executable);
  if (options.expectedVersion !== undefined && !path.basename(executable).includes(options.expectedVersion)) {
    throw new Error(`Smoke executable does not identify expected version ${options.expectedVersion}: ${executable}`);
  }

  await fs.mkdir(dataDirectory, { recursive: true });
  const workingDirectory = await fs.mkdtemp(path.join(dataDirectory, ".package-smoke-"));
  let child: ChildProcess | undefined;
  let captured: CapturedOutput = { stderr: "", stdout: "", combinedTail: "", readinessTail: "", forbiddenFallback: false };
  const sensitiveValues = sensitiveEnvironmentValues(process.env);

  try {
    const home = path.join(workingDirectory, "home");
    await fs.mkdir(home, { recursive: true });
    child = spawnSmokeExecutable(executable, {
      cwd: workingDirectory,
      shell: false,
      windowsHide: true,
      env: isolatedEnvironment(home, workingDirectory),
      stdio: ["ignore", "pipe", "pipe"],
    });
    captured = captureOutput(child, sensitiveValues);
    // spawn() can synchronously block in OS executable validation. The
    // readiness budget starts once creation returns and events can be observed.
    const deadline = Date.now() + timeoutMs;

    const url = await waitForLoopbackUrl(child, captured, executable, deadline, sensitiveValues);
    const healthStatus = await requestStatus(new URL("/health", url), executable, deadline, captured, sensitiveValues);
    const rootStatus = await requestStatus(new URL("/", url), executable, deadline, captured, sensitiveValues);
    if (healthStatus !== 200) throw smokeFailure(`Smoke /health returned HTTP ${healthStatus}`, executable, captured, sensitiveValues);
    if (rootStatus !== 200) throw smokeFailure(`Smoke / returned HTTP ${rootStatus}`, executable, captured, sensitiveValues);
    await delay(150);
    assertNoForbiddenFallback(captured, executable, sensitiveValues);
    await terminate(child, executable);
    return { healthStatus, rootStatus, stderr: sanitize(captured.stderr, sensitiveValues) };
  } catch (error) {
    if (child !== undefined) await terminate(child, executable);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(sanitize(message, sensitiveValues), { cause: error });
  } finally {
    await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function spawnSmokeExecutable(executable: string, options: Parameters<typeof spawn>[2]): ChildProcess {
  return spawn(executable, [], options);
}

async function requireExecutable(executable: string): Promise<void> {
  const stat = await fs.stat(executable);
  if (!stat.isFile()) throw new Error(`Smoke executable is not a file: ${executable}`);
}

function isolatedEnvironment(home: string, workingDirectory: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")),
    PATH: "",
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    THEAIHATCH_RUNTIME_CACHE: path.join(workingDirectory, "runtime"),
    THEAIHATCH_AUTO_OPEN: "0",
    THEAIHATCH_UPDATE_URL: "",
    THEAIHATCH_UPDATES_DISABLED: "1",
    PORT: "0",
    NODE_PATH: "",
    NODE_OPTIONS: "",
    TEMP: workingDirectory,
    TMP: workingDirectory,
    TMPDIR: workingDirectory,
  };
}

function captureOutput(child: ChildProcess, sensitiveValues: readonly string[]): CapturedOutput {
  const captured: CapturedOutput = { stderr: "", stdout: "", combinedTail: "", readinessTail: "", forbiddenFallback: false };
  child.on("error", (error) => { captured.error = error; });
  const append = (stream: "stderr" | "stdout", chunk: Buffer | string): void => {
    const text = chunk.toString();
    captured[stream] = appendBounded(captured[stream], text);
    captured.combinedTail = appendBounded(captured.combinedTail, text, stderrLimit);
    if (stream === "stdout") {
      const readinessText = `${captured.readinessTail}${text}`;
      if (captured.readinessUrl === undefined) {
        const readinessUrl = announcedLoopbackUrl(text) ?? announcedLoopbackUrl(readinessText);
        if (readinessUrl !== undefined) captured.readinessUrl = readinessUrl;
      }
      captured.readinessTail = appendBounded(readinessText, "", 512);
    }
    if (containsForbiddenFallback(sanitize(text, sensitiveValues))) captured.forbiddenFallback = true;
  };
  child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
  return captured;
}

async function waitForLoopbackUrl(child: ChildProcess, captured: CapturedOutput, executable: string, deadline: number, sensitiveValues: readonly string[]): Promise<string> {
  while (Date.now() < deadline) {
    if (captured.error !== undefined) throw smokeFailure(captured.error.message, executable, captured, sensitiveValues);
    assertNoForbiddenFallback(captured, executable, sensitiveValues);
    const url = captured.readinessUrl ?? announcedLoopbackUrl(captured.stdout);
    if (url !== undefined) return url;
    const exit = exited(child);
    if (exit !== undefined) throw smokeFailure(`Smoke executable exited with ${exit} before reporting readiness`, executable, captured, sensitiveValues);
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  throw smokeFailure("Timed out waiting for smoke executable readiness", executable, captured, sensitiveValues);
}

function announcedLoopbackUrl(stdout: string): string | undefined {
  const match = /theaihatch ready at (http:\/\/127\.0\.0\.1:(\d+))\b/iu.exec(stdout);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const port = Number(match[2]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? match[1] : undefined;
}

async function requestStatus(url: URL, executable: string, deadline: number, captured: CapturedOutput, sensitiveValues: readonly string[]): Promise<number> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const remaining = Math.max(1, deadline - Date.now());
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        return (await fetch(url, { signal: controller.signal })).status;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
  throw smokeFailure(`Timed out requesting ${url.pathname}`, executable, captured, sensitiveValues, lastError);
}

function assertNoForbiddenFallback(captured: CapturedOutput, executable: string, sensitiveValues: readonly string[]): void {
  const output = sanitize(captured.combinedTail, sensitiveValues).split("\\0").join("");
  if (captured.forbiddenFallback || containsForbiddenFallback(output)) {
    throw smokeFailure("Smoke executable reported forbidden fallback", executable, captured, sensitiveValues);
  }
}

function containsForbiddenFallback(output: string): boolean {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..").split(path.sep).join("/");
  const normalized = output.split("\\").join("/");
  return (
    /(?:spawn|exec(?:File)?)\s+(?:[^\n]*\s)?node(?:\.exe)?\b|child[_ -]?process|process\.execPath/iu.test(output) ||
    normalized.includes(`${repository}/node_modules/`) ||
    /(?:^|[\s:])(?:apps\/web\/(?:dist|src)|packages\/[^\s:]+\/src)\//imu.test(normalized)
  );
}

function exited(child: ChildProcess): string | undefined {
  if (child.exitCode !== null) return `exit code ${child.exitCode}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return undefined;
}

function smokeFailure(prefix: string, executable: string, captured: CapturedOutput, sensitiveValues: readonly string[], cause?: unknown): Error {
  const diagnostics = sanitize([captured.stderr, captured.stdout].filter(Boolean).join("\n"), sensitiveValues);
  const suffix = diagnostics.length === 0 ? "" : `\n${diagnostics}`;
  return new Error(`${prefix}: ${executable}${suffix}`, { cause });
}

async function terminate(child: ChildProcess, executable: string): Promise<void> {
  if (exited(child) !== undefined) return;
  const siblingPids = process.platform === "win32"
    ? await matchedWindowsChildPids(executable)
    : [];
  child.kill("SIGINT");
  const clean = await waitForExit(child, shutdownTimeoutMs);
  if (clean) {
    await Promise.all(siblingPids.filter((pid) => pid !== child.pid).map(forceWindowsTree));
    return;
  }

  if (process.platform === "win32" && child.pid !== undefined) {
    await forceWindowsTree(child.pid);
    await Promise.all(siblingPids.filter((pid) => pid !== child.pid).map(forceWindowsTree));
  } else {
    child.kill("SIGKILL");
  }
  await waitForExit(child, shutdownTimeoutMs);
}

async function forceWindowsTree(pid: number): Promise<void> {
  try { await runFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }); } catch { /* Process can exit while taskkill starts. */ }
}

async function matchedWindowsChildPids(executable: string): Promise<number[]> {
  const script = [
    "$target = $env:THEAIHATCH_SMOKE_TRACKED_EXECUTABLE",
    "$parent = [int]$env:THEAIHATCH_SMOKE_PARENT_PID",
    "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $parent -and ($_.ExecutablePath -eq $target -or ($_.CommandLine -replace '^\\\"|\\\"$') -eq $target) } | ForEach-Object { $_.ProcessId }",
  ].join("; ");
  try {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 2_000,
      env: { ...process.env, THEAIHATCH_SMOKE_TRACKED_EXECUTABLE: executable, THEAIHATCH_SMOKE_PARENT_PID: String(process.pid) },
    });
    return stdout.split(/\s+/u).map(Number).filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0);
  } catch {
    return [];
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exited(child) !== undefined) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function appendBounded(existing: string, next: string, limit = stderrLimit): string {
  return `${existing}${next}`.slice(-limit);
}

function sensitiveEnvironmentValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => value !== undefined && /(?:secret|token|password|authorization|cookie|api[_-]?key)/iu.test(key))
    .map(([, value]) => value!)
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
}

function sanitize(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const executable = option("--executable");
  if (executable === undefined) throw new Error("Usage: package:smoke -- --executable PATH [--data-directory PATH] [--expected-version VERSION]");
  const suppliedDataDirectory = option("--data-directory");
  const dataDirectory = suppliedDataDirectory ?? await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-smoke-data-"));
  try {
    const timeout = option("--timeout-ms");
    const expectedVersion = option("--expected-version");
    const result = await runPackageSmoke({
      executable,
      dataDirectory,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
      ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
    });
    console.log(JSON.stringify(result));
  } finally {
    if (suppliedDataDirectory === undefined) await fs.rm(dataDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
