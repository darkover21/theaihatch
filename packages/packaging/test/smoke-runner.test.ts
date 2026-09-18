import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { prepareSea } from "../src/sea.js";
import { runPackageSmoke } from "../src/smoke.js";

// Exercise real spawn while modeling slow synchronous OS creation and a file
// disappearing between stat and spawn.
const probe = vi.hoisted(() => ({ offset: 0, advance: false, missing: false, child: undefined as ChildProcess | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: (...args: Parameters<typeof original.spawn>) => {
    const child = original.spawn(probe.missing ? String(args[0]) + ".missing" : args[0], args[1], args[2]);
    probe.child = child;
    if (probe.advance) probe.offset += 10_000;
    return child;
  } };
});

const directories: string[] = [];
const smokeIt = process.versions.node.split(".")[0] === "22" ? it : it.skip;
let executable: string;
let fixtureDirectory: string;

beforeAll(async () => {
  if (process.versions.node.split(".")[0] !== "22") return;
  fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hatch-smoke-fixture-"));
  const launcher = path.join(fixtureDirectory, "fixture.cjs");
  executable = path.join(fixtureDirectory, process.platform === "win32" ? "fixture.exe" : "fixture");
  await build({ stdin: { contents: fixtureSource, loader: "js" }, outfile: launcher, bundle: true, platform: "node", target: "node22", format: "cjs" });
  await prepareSea(launcher, { "fixture-source": launcher }, executable);
}, 60_000);

afterAll(async () => {
  if (fixtureDirectory) await fs.rm(fixtureDirectory, { recursive: true, force: true });
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  probe.advance = false;
  probe.missing = false;
  probe.offset = 0;
  delete process.env.THEAIHATCH_SMOKE_TEST_SECRET;
  delete process.env.THEAIHATCH_SMOKE_TEST_UNLISTED;
  delete process.env.THEAIHATCH_SMOKE_TEST_MODE;
  delete process.env.THEAIHATCH_SMOKE_TEST_DIAGNOSTIC;
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
}, 60_000);

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hatch-smoke-"));
  directories.push(directory);
  return directory;
}

const fixtureSource = `
  import http from "node:http";
  import { spawn } from "node:child_process";
  import { appendFileSync, writeFileSync } from "node:fs";
  import os from "node:os";
  import path from "node:path";
  const mode = process.env.THEAIHATCH_SMOKE_TEST_MODE;
  const secret = process.env.THEAIHATCH_SMOKE_TEST_UNLISTED ?? process.env.THEAIHATCH_SMOKE_TEST_SECRET ?? "";
  if (process.argv.length !== 2 || process.env.THEAIHATCH_AUTO_OPEN !== "0" || process.env.THEAIHATCH_UPDATE_URL !== "" || process.env.THEAIHATCH_UPDATES_DISABLED !== "1" || process.env.PORT !== "0" || process.env.NODE_PATH !== "" || process.env.NODE_OPTIONS !== "" || process.env.PATH !== "" || !os.homedir().startsWith(process.cwd() + path.sep)) {
    console.error("smoke environment was not isolated", JSON.stringify({ argc: process.argv.length, homeIsolated: os.homedir().startsWith(process.cwd() + path.sep), pathEmpty: process.env.PATH === "", nodePathEmpty: process.env.NODE_PATH === "", nodeOptionsEmpty: process.env.NODE_OPTIONS === "" }));
    process.exit(17);
  }
  if (mode === "timeout") {
    console.error(secret);
    setInterval(() => {}, 1000);
  } else if (mode === "nonzero") {
    process.stdout.write("stdout-before-exit\\n");
    process.stderr.write("stderr-before-exit " + secret + "\\n", () => process.exit(7));
  } else if (mode === "orphan-parent") {
    const marker = process.env.THEAIHATCH_SMOKE_TEST_MARKER;
    if (marker === undefined) process.exit(18);
    writeFileSync(marker, "parent\\n");
    spawn(process.execPath, [], { env: { ...process.env, THEAIHATCH_SMOKE_TEST_MODE: "orphan-child" }, stdio: "ignore" });
    setTimeout(() => process.exit(0), 100);
  } else if (mode === "orphan-child") {
    const marker = process.env.THEAIHATCH_SMOKE_TEST_MARKER;
    if (marker === undefined) process.exit(19);
    const interval = setInterval(() => appendFileSync(marker, "child\\n"), 25);
    process.once("SIGINT", () => { clearInterval(interval); process.exit(0); });
  } else if (mode === "fallback") {
    console.error(process.env.THEAIHATCH_SMOKE_TEST_DIAGNOSTIC);
    process.stderr.write("x".repeat(20000));
    setInterval(() => {}, 1000);
  } else {
    const server = http.createServer((request, response) => {
      response.statusCode = mode === "bad-health" && request.url === "/health" ? 503 : mode === "bad-root" && request.url === "/" ? 404 : 200;
      response.end(request.url === "/health" ? "healthy" : "embedded root");
    });
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write("theaihatch ready at http://127.0.0.1:" + server.address().port + "\\n");
      if (mode === "verbose") {
        process.stdout.write("x".repeat(20000));
        process.stderr.write("x".repeat(20000) + secret.slice(0, 6));
        setTimeout(() => process.stderr.write(secret.slice(6) + "\\n"), 10);
      } else console.error("fixture stderr");
    });
    process.on("SIGINT", () => {
      if (mode !== "stubborn") server.close(() => process.exit(0));
    });
  }
`;

it("reports asynchronous spawn errors without an unhandled error event", async () => {
  const file = path.join(await temporaryDirectory(), "unlaunchable.exe");
  await fs.writeFile(file, "placeholder");
  probe.missing = true;
  const result = await runPackageSmoke({ executable: file, dataDirectory: await temporaryDirectory(), timeoutMs: 1_000 }).catch((error: Error) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain(file);
  expect((result as Error).message).toMatch(/spawn.*ENOENT/i);
});

smokeIt("launches the supplied executable with isolated paths, checks both routes, and preserves user files", async () => {
  const dataDirectory = await temporaryDirectory();
  await fs.writeFile(path.join(dataDirectory, "keep.txt"), "user data");
  await expect(runPackageSmoke({ executable, dataDirectory, timeoutMs: 5_000 })).resolves.toEqual({ healthStatus: 200, rootStatus: 200, stderr: "fixture stderr\n" });
  expect(probe.child?.exitCode !== null || probe.child?.signalCode !== null).toBe(true);
  expect(await fs.readdir(dataDirectory)).toEqual(["keep.txt"]);
  expect(await fs.readFile(path.join(dataDirectory, "keep.txt"), "utf8")).toBe("user data");
}, 60_000);

smokeIt("starts the readiness budget after synchronous OS process creation returns", async () => {
  const now = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => now() + probe.offset);
  probe.advance = true;
  await expect(runPackageSmoke({ executable, dataDirectory: await temporaryDirectory(), timeoutMs: 5_000 })).resolves.toMatchObject({ healthStatus: 200, rootStatus: 200 });
}, 60_000);

smokeIt("retains readiness through an output flood and redacts secrets split across stderr chunks", async () => {
  process.env.THEAIHATCH_SMOKE_TEST_UNLISTED = "hunter2";
  process.env.THEAIHATCH_SMOKE_TEST_MODE = "verbose";
  const result = await runPackageSmoke({ executable, dataDirectory: await temporaryDirectory(), timeoutMs: 5_000 });
  expect(result.stderr).not.toContain("hunter2");
  expect(result.stderr).toContain("[REDACTED]");
  expect(result.stderr.length).toBeLessThanOrEqual(16_384);
}, 60_000);

smokeIt("reports a bounded readiness timeout with redacted executable diagnostics", async () => {
  process.env.THEAIHATCH_SMOKE_TEST_SECRET = "smoke-secret-value";
  process.env.THEAIHATCH_SMOKE_TEST_MODE = "timeout";
  const result = await runPackageSmoke({ executable, dataDirectory: await temporaryDirectory(), timeoutMs: 100 }).catch((error: Error) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain(executable);
  expect((result as Error).message).toMatch(/Timed out.*readiness/);
  expect((result as Error).message).not.toContain("smoke-secret-value");
  expect(probe.child?.exitCode !== null || probe.child?.signalCode !== null).toBe(true);
}, 60_000);

smokeIt("captures both output streams on an immediate nonzero exit and redacts the error", async () => {
  process.env.THEAIHATCH_SMOKE_TEST_SECRET = "smoke-secret-value";
  process.env.THEAIHATCH_SMOKE_TEST_MODE = "nonzero";
  const result = await runPackageSmoke({ executable, dataDirectory: await temporaryDirectory(), timeoutMs: 5_000 }).catch((error: Error) => error);
  expect((result as Error).message).toContain(executable);
  expect((result as Error).message).toMatch(/exit code 7/);
  expect((result as Error).message).toContain("stdout-before-exit");
  expect((result as Error).message).toContain("stderr-before-exit [REDACTED]");
  expect((result as Error).message).not.toContain("smoke-secret-value");
}, 60_000);

smokeIt.each([
  ["Node invocation", "fallback: spawn node.exe"],
  ["quoted Node invocation", 'fallback: spawn("node")'],
  ["repository node_modules read", "fallback: read " + path.resolve(import.meta.dirname, "../../..", "node_modules/keytar/index.js")],
  ["repository-relative asset", "fallback: read apps/web/dist/index.html"],
  ["server source asset", "fallback: read apps/server/src/index.ts"],
  ["dist asset", "fallback: read dist/index.html"],
])("rejects %s even before a diagnostic flood", async (_name, diagnostic) => {
  process.env.THEAIHATCH_SMOKE_TEST_MODE = "fallback";
  process.env.THEAIHATCH_SMOKE_TEST_DIAGNOSTIC = diagnostic;
  await expect(runPackageSmoke({ executable, dataDirectory: await temporaryDirectory(), timeoutMs: 1_000 })).rejects.toThrow(/forbidden fallback/i);
}, 60_000);

smokeIt.each(["bad-health", "bad-root"])("rejects %s HTTP responses", async (mode) => {
  process.env.THEAIHATCH_SMOKE_TEST_MODE = mode;
  await expect(runPackageSmoke({ executable, dataDirectory: await temporaryDirectory(), timeoutMs: 1_000 })).rejects.toThrow(/503|404/);
}, 60_000);

smokeIt("terminates a child that does not cooperate with SIGINT", async () => {
  process.env.THEAIHATCH_SMOKE_TEST_MODE = "stubborn";
  await expect(runPackageSmoke({ executable, dataDirectory: await temporaryDirectory(), timeoutMs: 5_000 })).resolves.toMatchObject({ healthStatus: 200 });
  expect(probe.child?.exitCode !== null || probe.child?.signalCode !== null).toBe(true);
}, 60_000);

smokeIt("terminates descendants when the executable exits first", async () => {
  const dataDirectory = await temporaryDirectory();
  const marker = path.join(dataDirectory, "descendant.log");
  process.env.THEAIHATCH_SMOKE_TEST_MODE = "orphan-parent";
  process.env.THEAIHATCH_SMOKE_TEST_MARKER = marker;
  await expect(runPackageSmoke({ executable, dataDirectory, timeoutMs: 5_000 })).rejects.toThrow(/exit code 0/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterTermination = await fs.stat(marker);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterWait = await fs.stat(marker);
  expect(afterWait.size).toBe(afterTermination.size);
}, 60_000);
