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
  descendantProcesses: Map<number, WindowsProcessIdentity>;
  readinessUrl?: string;
  descendantQuery?: Promise<void>;
  forbiddenFallback: boolean;
  error?: Error;
}

interface WindowsProcessIdentity {
  pid: number;
  creationDate: string;
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
  let captured: CapturedOutput = { stderr: "", stdout: "", combinedTail: "", readinessTail: "", descendantProcesses: new Map(), forbiddenFallback: false };
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
    captured = captureOutput(child);
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
    await terminate(child, executable, captured);
    return { healthStatus, rootStatus, stderr: sanitizeBounded(captured.stderr, sensitiveValues) };
  } catch (error) {
    if (child !== undefined) await terminate(child, executable, captured);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message, { cause: error });
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

function captureOutput(child: ChildProcess): CapturedOutput {
  const captured: CapturedOutput = { stderr: "", stdout: "", combinedTail: "", readinessTail: "", descendantProcesses: new Map(), forbiddenFallback: false };
  child.on("error", (error) => { captured.error = error; });
  if (process.platform === "win32") child.once("exit", () => { void trackDescendants(captured, child.pid); });
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
    if (containsForbiddenFallback(text)) captured.forbiddenFallback = true;
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
  const output = captured.combinedTail.split("\\0").join("");
  if (captured.forbiddenFallback || containsForbiddenFallback(output)) {
    throw smokeFailure("Smoke executable reported forbidden fallback", executable, captured, sensitiveValues);
  }
}

function containsForbiddenFallback(output: string): boolean {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..").split(path.sep).join("/");
  const normalized = output.split("\\").join("/");
  const nodeInvocation = /\b(?:spawn|spawnSync|exec|execFile|execFileSync|fork)\b[^\r\n]*\bnode(?:\.exe)?\b/iu.test(normalized) ||
    /(?:^|[^a-z0-9_./-])node(?:\.exe)?(?:$|[\s"'`])/iu.test(normalized);
  const repositoryRelativePath = /(?:^|[^a-z0-9_])(?:apps|packages|dist|node_modules)\/[^\s"'`<>]+/iu.test(normalized);
  return (
    nodeInvocation ||
    /child[_ -]?process|process\.execPath/iu.test(output) ||
    normalized.includes(`${repository}/node_modules/`) ||
    repositoryRelativePath
  );
}

function exited(child: ChildProcess): string | undefined {
  if (child.exitCode !== null) return `exit code ${child.exitCode}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return undefined;
}

function smokeFailure(prefix: string, executable: string, captured: CapturedOutput, sensitiveValues: readonly string[], cause?: unknown): Error {
  const diagnostics = sanitizeBounded([captured.stderr, captured.stdout].filter(Boolean).join("\n"), sensitiveValues);
  const suffix = diagnostics.length === 0 ? "" : `\n${diagnostics}`;
  return new Error(`${prefix}: ${executable}${suffix}`, { cause });
}

async function terminate(child: ChildProcess, executable: string, captured: CapturedOutput): Promise<void> {
  if (process.platform === "win32" && child.pid !== undefined) {
    if (exited(child) === undefined) {
      await trackDescendants(captured, child.pid);
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (captured.descendantQuery === undefined) await trackDescendants(captured, child.pid);
      else await captured.descendantQuery;
    }
  }
  if (exited(child) !== undefined) {
    await Promise.all([...captured.descendantProcesses.values()].map(terminateWindowsProcessTree));
    return;
  }
  const rootIdentity = process.platform === "win32" && child.pid !== undefined
    ? await windowsProcessIdentity(child.pid)
    : undefined;
  child.kill("SIGINT");
  const clean = await waitForExit(child, shutdownTimeoutMs);
  if (captured.descendantQuery !== undefined) await captured.descendantQuery;
  if (clean) {
    await Promise.all([...captured.descendantProcesses.values()].map(terminateWindowsProcessTree));
    return;
  }

  if (rootIdentity !== undefined) {
    await terminateWindowsProcessTree(rootIdentity);
    await Promise.all([...captured.descendantProcesses.values()].map(terminateWindowsProcessTree));
  } else {
    child.kill("SIGKILL");
  }
  await waitForExit(child, shutdownTimeoutMs);
}

async function terminateWindowsProcessTree(identity: WindowsProcessIdentity): Promise<void> {
  const script = [
    "$targetPid = [int]$env:THEAIHATCH_SMOKE_TARGET_PID",
    "$targetCreation = [string]$env:THEAIHATCH_SMOKE_TARGET_CREATION",
    "$all = @(Get-CimInstance Win32_Process)",
    "$target = @($all | Where-Object { [int]$_.ProcessId -eq $targetPid -and [string]$_.CreationDate -eq $targetCreation })",
    "if ($target.Count -gt 0) { $pending = @($targetPid); $targets = @($target[0]); while ($pending.Count -gt 0) { $parentId = $pending[0]; if ($pending.Count -eq 1) { $pending = @() } else { $pending = @($pending[1..($pending.Count - 1)]) }; foreach ($item in @($all | Where-Object { [int]$_.ParentProcessId -eq $parentId })) { if (@($targets | Where-Object { [int]$_.ProcessId -eq [int]$item.ProcessId }).Count -eq 0) { $targets += $item; $pending += [int]$item.ProcessId } } }; $current = @(Get-CimInstance Win32_Process); foreach ($item in $targets) { $match = @($current | Where-Object { [int]$_.ProcessId -eq [int]$item.ProcessId -and [string]$_.CreationDate -eq [string]$item.CreationDate }); if ($match.Count -gt 0) { Invoke-CimMethod -InputObject $match[0] -MethodName Terminate | Out-Null } } }",
  ].join("; ");
  try {
    await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: shutdownTimeoutMs,
      env: {
        ...process.env,
        THEAIHATCH_SMOKE_TARGET_PID: String(identity.pid),
        THEAIHATCH_SMOKE_TARGET_CREATION: identity.creationDate,
      },
    });
  } catch { /* Process can exit while identity validation or termination starts. */ }
}

async function trackDescendants(captured: CapturedOutput, rootPid: number | undefined): Promise<void> {
  if (process.platform !== "win32" || rootPid === undefined) return;
  const query = windowsDescendantProcesses(rootPid).then((processes) => {
    for (const process of processes) captured.descendantProcesses.set(process.pid, process);
  }, () => undefined);
  captured.descendantQuery = query;
  await query;
}

async function windowsProcessIdentity(pid: number): Promise<WindowsProcessIdentity | undefined> {
  const script = [
    "$targetProcessId = [int]$env:THEAIHATCH_SMOKE_ROOT_PID",
    "$process = Get-CimInstance Win32_Process | Where-Object { [int]$_.ProcessId -eq $targetProcessId } | Select-Object -First 1",
    "if ($null -ne $process) { [pscustomobject]@{ ProcessId = [int]$process.ProcessId; CreationDate = [string]$process.CreationDate } | ConvertTo-Json -Compress }",
  ].join("; ");
  try {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 2_000,
      env: { ...process.env, THEAIHATCH_SMOKE_ROOT_PID: String(pid) },
    });
    const parsed = JSON.parse(stdout.trim()) as { ProcessId?: number; CreationDate?: string };
    if (parsed.ProcessId === undefined || parsed.CreationDate === undefined) return undefined;
    return { pid: parsed.ProcessId, creationDate: parsed.CreationDate };
  } catch {
    return undefined;
  }
}

async function windowsDescendantProcesses(rootPid: number): Promise<WindowsProcessIdentity[]> {
  const script = [
    "$root = [int]$env:THEAIHATCH_SMOKE_ROOT_PID",
    "$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)",
    "$pending = @($root)",
    "$found = @()",
    "while ($pending.Count -gt 0) { $parentId = $pending[0]; if ($pending.Count -eq 1) { $pending = @() } else { $pending = @($pending[1..($pending.Count - 1)]) }; foreach ($item in @($all | Where-Object { [int]$_.ParentProcessId -eq $parentId })) { $childPid = [int]$item.ProcessId; if (@($found | Where-Object { [int]$_.ProcessId -eq $childPid }).Count -eq 0) { $found += $item; $pending += $childPid } } }",
    "$found | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.ProcessId; CreationDate = [string]$_.CreationDate } } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 2_000,
      env: { ...process.env, THEAIHATCH_SMOKE_ROOT_PID: String(rootPid) },
    });
    if (stdout.trim() === "") return [];
    const parsed = JSON.parse(stdout.trim()) as { ProcessId?: number; CreationDate?: string } | Array<{ ProcessId?: number; CreationDate?: string }>;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.filter((entry): entry is { ProcessId: number; CreationDate: string } =>
      entry.ProcessId !== undefined && entry.CreationDate !== undefined,
    ).map((entry) => ({ pid: entry.ProcessId, creationDate: entry.CreationDate }));
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
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined && value.length > 0)
    .sort((left, right) => right.length - left.length);
}

function sanitize(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
}

function sanitizeBounded(value: string, sensitiveValues: readonly string[]): string {
  return appendBounded("", sanitize(value, sensitiveValues));
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
