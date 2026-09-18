import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";

const run = promisify(execFile);

export interface ListenOptions {
  preferredPort: number;
  fallbackCount?: number;
  host?: "127.0.0.1";
}

export interface ReadinessOptions {
  timeoutMs?: number;
  intervalMs?: number;
  fetcher?: typeof fetch;
}

type BrowserExecute = (file: string, args: readonly string[]) => Promise<void>;

export async function listenLoopback(app: FastifyInstance, options: ListenOptions): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const fallbackCount = options.fallbackCount ?? 20;
  const candidates = options.preferredPort === 0
    ? [0]
    : Array.from({ length: fallbackCount + 1 }, (_, index) => options.preferredPort + index);
  let lastError: unknown;

  for (const port of candidates) {
    try {
      await app.listen({ host, port });
      const address = app.server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    } catch (error) {
      if (!isAddressInUseError(error)) throw error;
      lastError = error;
    }
  }

  throw new Error("no available loopback port in fallback range", { cause: lastError });
}

export async function waitForReadiness(url: string, options: ReadinessOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const fetcher = options.fetcher ?? fetch;
  const deadline = Date.now() + timeoutMs;
  const healthUrl = new URL("/health", `${url}/`).toString();

  while (Date.now() < deadline) {
    try {
      const response = await fetchBeforeDeadline(fetcher, healthUrl, deadline);
      if (response.ok) return;
    } catch (error) {
      if (Date.now() >= deadline) throw readinessTimeout(url, error);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await delay(Math.min(intervalMs, remainingMs));
  }

  throw readinessTimeout(url);
}

export async function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  execute: BrowserExecute = executeFile,
): Promise<void> {
  if (platform === "win32") await execute("cmd", ["/c", "start", "", url]);
  else if (platform === "darwin") await execute("open", [url]);
  else await execute("xdg-open", [url]);
}

async function executeFile(file: string, args: readonly string[]): Promise<void> {
  await run(file, [...args]);
}

async function fetchBeforeDeadline(fetcher: typeof fetch, url: string, deadline: number): Promise<Response> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw readinessTimeout(url);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetcher(url),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(readinessTimeout(url)), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function readinessTimeout(url: string, cause?: unknown): Error {
  return new Error(`timed out waiting for server readiness at ${url}`, { cause });
}

function isAddressInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EADDRINUSE" || /address already in use/iu.test(error.message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
