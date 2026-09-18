# Phase 6A Packaging Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** Build and verify a Node SEA-based packaged runtime that embeds the web UI and server launcher, initializes safely, starts on loopback, and verifies signed release metadata.

**Architecture:** Keep the current Fastify route composition and development/Vite path intact while introducing an injected AssetProvider boundary for filesystem and SEA assets. A packaging library will stage the web build, bundle the server launcher, inventory native modules, inject the SEA blob into the host Node runtime, and emit an integrity manifest. Startup will be factored into testable first-run, listen/readiness, and update-check services.

**Tech Stack:** Node 22+, TypeScript strict ESM, Fastify 5, Vite/Vite Node, esbuild, Node SEA, postject, Vitest, and existing better-sqlite3/keytar native modules.

**Spec:** docs/superpowers/specs/2026-09-18-phase-6-packaging-design.md

## Global Constraints

- Supported targets are exactly windows-x64, macos-arm64, and linux-x64.
- Packaged startup binds only to 127.0.0.1 and uses a bounded fallback range.
- A packaged artifact must serve the built UI without Node, Vite, repository-relative asset paths, or the repository's node_modules directory.
- First-run state must be atomic and resumable; an interrupted step must be safe to retry.
- Update checks are signed, fail closed, rate-limited to once per 24 hours by default, and never install automatically.
- Native-module incompatibility is a hard packaging failure; no manifest may be emitted for a false-positive artifact.
- Development continues to use the existing Vite commands and source asset paths.
- Every implementation task follows red test, focused green test, broader regression test, and a focused commit.

## File map

- packages/packaging/src/build.ts: target names, staging layout, SEA plan, manifests, and checksum generation.
- packages/packaging/src/native.ts: native runtime-module discovery and integrity metadata.
- packages/packaging/src/cli.ts: host-native plan/build command line entrypoint.
- packages/packaging/src/smoke.ts: executable smoke launcher and clean-environment assertions.
- packages/packaging/src/index.ts: public packaging exports.
- packages/packaging/test/*.test.ts: pure packaging, native inventory, and artifact tests.
- apps/server/src/bootstrap/assets.ts: filesystem/embedded asset providers and safe Fastify web fallback.
- apps/server/src/bootstrap/first-run.ts: versioned atomic initialization state.
- apps/server/src/bootstrap/storage.ts: idempotent SQLite initialization hook.
- apps/server/src/bootstrap/listen.ts: actual Fastify bind fallback, readiness polling, and browser launch.
- apps/server/src/bootstrap/start.ts: dependency-injected application startup and shutdown lifecycle.
- apps/server/src/app.ts: route composition extracted from the current top-level server entrypoint.
- apps/server/src/index.ts: development entrypoint and compatibility export for createServer.
- apps/server/src/sea-entry.ts: packaged executable entrypoint.
- apps/server/src/updates/check.ts: canonical release metadata, signature verification, and rate limiting.
- apps/server/test/assets.test.ts: asset boundary and SPA fallback tests.
- apps/server/test/bootstrap.test.ts: first-run, listen, readiness, browser, and update tests.
- apps/server/test/start.test.ts: startup dependency ordering and cleanup tests.
- apps/web/dist: generated staging input only; it remains ignored.
- package.json and package-lock.json: packaging scripts and direct build dependencies.
- docs/plan.md: Phase 6A task checkmarks after all acceptance tests pass.

---

### Task 1: Define packaging contracts and prove native-module inputs

**Files:**
- Create: packages/packaging/src/native.ts
- Modify: packages/packaging/src/build.ts
- Modify: packages/packaging/src/index.ts
- Modify: packages/packaging/test/smoke.test.ts
- Create: packages/packaging/test/native.test.ts

**Interfaces:**
- ReleaseTarget remains the union "windows-x64" | "macos-arm64" | "linux-x64".
- RELEASE_TARGETS is a readonly tuple containing those three targets in that order.
- NativeAddonName is "better-sqlite3" | "keytar".
- NativeAddonAsset is { packageName: NativeAddonName; packageRoot: string; binaryPath: string; assetKey: string; sha256: string }.
- PackageLayout is { target: ReleaseTarget; releaseVersion: string; stagingDirectory: string; webDirectory: string; launcherPath: string; executablePath: string; manifestPath: string; checksumPath: string }.
- ArtifactManifest is { schemaVersion: 1; target: ReleaseTarget; releaseVersion: string; executable: string; executableSha256: string; embeddedAssetSha256: string }.
- targetExecutableName(target, releaseVersion): string returns theaihatch- plus releaseVersion plus - plus target, with .exe only for windows-x64.
- packageLayout(root: string, target: ReleaseTarget, releaseVersion: string): PackageLayout returns all paths below root without touching the filesystem.
- discoverNativeAddonAssets(projectRoot): Promise<readonly NativeAddonAsset[]> finds the runtime package trees and native binaries required by the current platform and rejects a missing better-sqlite3 or keytar binary with the package name and expected path.
- seaBuildPlan(target, layout, nativeAssets): SeaBuildPlan returns { target, mode: "node-sea"; executableName: string; assets: Record<string, string>; nativeAssets: readonly NativeAddonAsset[] }.
- createArtifactManifest(target, releaseVersion, executable, embeddedAssetSha256): Promise<ArtifactManifest> hashes the final executable bytes.
- writeArtifactManifest(path, manifest): Promise<void> writes stable two-space JSON and a sibling .sha256 file containing the executable digest and filename.

- [ ] Step 1: Write failing contract and native-discovery tests

Add tests that assert all three targets have deterministic executable names and layouts, that the SEA plan contains a web asset, launcher asset, and native assets, and that the current checkout discovers both native packages. Add a missing-binary fixture that expects an error containing the affected package name.

~~~
it("REQ-PKG-001: plans every release target with explicit assets", () => {
  for (const target of RELEASE_TARGETS) {
    const layout = packageLayout("/tmp/out", target, "0.1.0");
    const plan = seaBuildPlan(target, layout, []);
    expect(plan).toMatchObject({ target, mode: "node-sea" });
    expect(Object.keys(plan.assets)).toEqual(expect.arrayContaining(["web", "launcher"]));
  }
});

it("REQ-PKG-001: reports missing native runtime inputs", async () => {
  await expect(discoverNativeAddonAssets("/fixture-without-node-modules"))
    .rejects.toThrow(/better-sqlite3|keytar/u);
});
~~~

- [ ] Step 2: Run the focused tests and verify failure

Run: npm exec vitest run packages/packaging/test/smoke.test.ts packages/packaging/test/native.test.ts

Expected: FAIL because the new layout, native discovery, and manifest interfaces do not exist.

- [ ] Step 3: Implement the pure layout, manifest, and native inventory functions

Use createRequire(import.meta.url) to resolve package roots from projectRoot. Walk only the runtime package trees needed by the launcher, identify the platform-specific .node file, hash it with SHA-256, and create stable SEA asset keys. Keep the inventory separate from command execution so tests can assert paths and digests without invoking Node SEA. Preserve writeSeaConfig as a compatibility export, but make it consume the new asset map and absolute paths.

- [ ] Step 4: Run focused tests and typecheck

Run: npm exec vitest run packages/packaging/test/smoke.test.ts packages/packaging/test/native.test.ts

Run: npm run typecheck

Expected: focused tests and typecheck pass.

- [ ] Step 5: Commit the packaging contracts

~~~
git add packages/packaging
git commit -m "feat(packaging): define target and native asset contracts"
~~~

### Task 2: Add the safe filesystem and embedded web asset boundary

**Files:**
- Create: apps/server/src/bootstrap/assets.ts
- Create: apps/server/test/assets.test.ts
- Create: apps/server/src/app.ts
- Modify: apps/server/src/index.ts

**Interfaces:**
- AssetFile is { body: Buffer; contentType: string }.
- AssetProvider is { read(logicalPath: string): Promise<AssetFile | null> }.
- createFilesystemAssetProvider(root: string): AssetProvider reads only normalized relative paths under root.
- createEmbeddedAssetProvider(readAsset: (key: string) => Promise<Buffer | null>, prefix?: string): AssetProvider maps logical web paths to SEA asset keys.
- registerWebAssets(app: FastifyInstance, provider: AssetProvider): void registers GET / and a wildcard browser route while leaving /api/* and /health to their existing handlers.
- createServer(eventSink?: WorkspaceEventSink, mcpToken?: string, assetProvider?: AssetProvider): FastifyInstance retains the existing callers and optionally registers production web assets.

- [ ] Step 1: Write failing asset and server-route tests

Test a temporary filesystem provider for /index.html and /assets/app.js, reject ../secret, serve a missing browser route with index.html, and verify that /api/not-found remains a 404 rather than receiving the SPA document. Test the embedded provider with an in-memory asset map. Construct the server through createServer and use Fastify injection.

~~~
it("REQ-PKG-001: serves embedded assets and keeps API paths separate", async () => {
  const app = createServer(undefined, undefined, createEmbeddedAssetProvider(async (key) => assets.get(key) ?? null));
  expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/workspace/demo" })).body).toContain("root");
  expect((await app.inject({ method: "GET", url: "/api/missing" })).statusCode).toBe(404);
  await app.close();
});
~~~

- [ ] Step 2: Run the focused tests and verify failure

Run: npm exec vitest run apps/server/test/assets.test.ts

Expected: FAIL because no asset provider or production web route exists.

- [ ] Step 3: Implement normalized asset providers and content types

Normalize URL paths with POSIX semantics, strip the leading slash, reject empty/absolute/traversal paths, and map unknown browser routes to index.html. Use a small explicit content-type table for html, js, css, json, svg, png, jpg, ico, and map; default to application/octet-stream. Never call path.join with an unvalidated user path. Embedded reads must return null for absent keys.

- [ ] Step 4: Extract route composition into app.ts and wire optional assets

Move the current createServer body into apps/server/src/app.ts, preserve its health/workspace/agent/MCP registrations, and call registerWebAssets only when an AssetProvider is supplied. Keep apps/server/src/index.ts as the compatibility export and development startup file; do not change API response shapes.

- [ ] Step 5: Run focused regression tests

Run: npm exec vitest run apps/server/test/assets.test.ts apps/server/test/agent-routes.test.ts apps/server/test/workspace-terminal.test.ts

Expected: all focused tests pass.

- [ ] Step 6: Commit the asset boundary

~~~
git add apps/server/src/app.ts apps/server/src/index.ts apps/server/src/bootstrap/assets.ts apps/server/test/assets.test.ts
git commit -m "feat(server): serve packaged web assets safely"
~~~

### Task 3: Make first-run initialization atomic and resumable

**Files:**
- Modify: apps/server/src/bootstrap/first-run.ts
- Create: apps/server/src/bootstrap/storage.ts
- Modify: apps/server/test/bootstrap.test.ts
- Create: apps/server/test/first-run.test.ts

**Interfaces:**
- FirstRunStep is "directories" | "storage" | "keychain".
- FirstRunState is { version: 2; initialized: boolean; dataDirectory: string; keychainVerified: boolean; completedSteps: readonly FirstRunStep[] }.
- FirstRunOptions is { dataDirectory?: string; verifyKeychain?: () => Promise<boolean>; initializeStorage?: (dataDirectory: string) => Promise<void> }.
- initializeFirstRun(options?: FirstRunOptions): Promise<FirstRunState> defaults dataDirectory to userPaths().data, uses an idempotent storage initializer, and migrates a valid version-1 state.
- initializeStorage(dataDirectory: string): Promise<void> creates the application SQLite boundary by opening and closing SessionRepository at the data directory.

- [ ] Step 1: Write failing interruption and migration tests

Cover a fresh run, a second run that does not invoke injected steps again, a storage failure after the directory step, a retry that completes storage and keychain, a malformed state file, and a version-1 state migration. Assert that no final state file contains a partially written JSON document and that the temporary state file is not treated as initialized.

~~~
it("REQ-PKG-002: resumes after storage initialization fails", async () => {
  let attempts = 0;
  await expect(initializeFirstRun({
    dataDirectory: directory,
    initializeStorage: async () => { attempts += 1; throw new Error("storage unavailable"); }
  })).rejects.toThrow("storage unavailable");
  await initializeFirstRun({ dataDirectory: directory, initializeStorage: async () => { attempts += 1; } });
  expect(attempts).toBe(2);
  expect(JSON.parse(await fs.readFile(path.join(directory, "first-run.json"), "utf8"))).toMatchObject({ version: 2, initialized: true });
});
~~~

- [ ] Step 2: Run the focused tests and verify failure

Run: npm exec vitest run apps/server/test/bootstrap.test.ts apps/server/test/first-run.test.ts

Expected: FAIL because the current state is version 1, writes in place, and has no injected storage step.

- [ ] Step 3: Implement atomic state writes and step checkpoints

Write JSON to first-run.json.tmp, close the file handle, and rename it to first-run.json. Persist a completed step only after that step resolves. On startup, load only valid state, merge version-1 fields into the version-2 shape, and rerun only incomplete steps. Keep keychainVerified as the observed verification result. Do not swallow injected step errors before the state can be retried.

- [ ] Step 4: Add the storage initializer and run focused verification

Implement initializeStorage with SessionRepository, close the repository in a finally block, then run:

~~~
npm exec vitest run apps/server/test/bootstrap.test.ts apps/server/test/first-run.test.ts packages/storage/test/sessions.test.ts
npm run typecheck
~~~

Expected: all tests pass and no SQLite handle remains open after the initializer returns.

- [ ] Step 5: Commit resumable first-run state

~~~
git add apps/server/src/bootstrap/first-run.ts apps/server/src/bootstrap/storage.ts apps/server/test/bootstrap.test.ts apps/server/test/first-run.test.ts
git commit -m "feat(server): make first-run initialization resumable"
~~~

### Task 4: Implement real loopback fallback, readiness, and startup lifecycle

**Files:**
- Modify: apps/server/src/bootstrap/listen.ts
- Create: apps/server/src/bootstrap/start.ts
- Create: apps/server/test/start.test.ts
- Modify: apps/server/test/bootstrap.test.ts
- Modify: apps/server/src/index.ts

**Interfaces:**
- ListenOptions is { preferredPort: number; fallbackCount?: number; host?: "127.0.0.1" }.
- listenLoopback(app: FastifyInstance, options: ListenOptions): Promise<number> attempts the actual Fastify bind on the preferred port followed by the bounded fallback ports and returns the bound port.
- waitForReadiness(url: string, options?: { timeoutMs?: number; intervalMs?: number; fetcher?: typeof fetch }): Promise<void> polls /health until a 2xx response or throws a timeout error.
- openBrowser(url: string, platform?: NodeJS.Platform, execute?: (file: string, args: readonly string[]) => Promise<void>): Promise<void> keeps the platform command mapping and makes execution injectable.
- StartServerOptions is { dataDirectory?: string; preferredPort?: number; fallbackCount?: number; autoOpen?: boolean; assetProvider?: AssetProvider; keychain?: Keychain; createApp?: (mcpToken: string, assetProvider?: AssetProvider) => FastifyInstance; browserOpener?: (url: string) => Promise<void>; readiness?: (url: string) => Promise<void> }.
- StartedServer is { app: FastifyInstance; host: "127.0.0.1"; port: number; url: string; close(): Promise<void> }.
- startServer(options?: StartServerOptions): Promise<StartedServer> initializes first-run/storage, obtains or creates the MCP token, binds the app, waits for health, optionally opens the browser, and returns a closeable lifecycle.

- [ ] Step 1: Write failing bind, readiness, browser, and lifecycle tests

Use two Fastify instances to occupy the preferred port and assert that listenLoopback binds the next candidate. Add an exhaustion test with a small range, a readiness test with a fake fetcher that returns 503 then 200, and a browser test that records the exact URL and platform command. Inject fake keychain, app factory, readiness, and browser functions into startServer and assert the order: first-run, token, bind, readiness, browser.

~~~
it("REQ-PKG-003: binds the first available fallback with the real app", async () => {
  const occupied = Fastify();
  await occupied.listen({ host: "127.0.0.1", port: 0 });
  const address = occupied.server.address();
  const preferred = typeof address === "object" && address !== null ? address.port : 0;
  const app = Fastify();
  const selected = await listenLoopback(app, { preferredPort: preferred, fallbackCount: 2 });
  expect(selected).not.toBe(preferred);
  await app.close();
  await occupied.close();
});
~~~

- [ ] Step 2: Run focused tests and verify failure

Run: npm exec vitest run apps/server/test/bootstrap.test.ts apps/server/test/start.test.ts

Expected: FAIL because startup probes and closes a separate net server, has no readiness function, and has no injectable lifecycle.

- [ ] Step 3: Implement actual Fastify bind retry and readiness polling

Retry only EADDRINUSE/address-in-use errors; propagate all other listen failures. Use a candidate list of the preferred port followed by preferredPort + 1 through the configured bound. Treat preferred port 0 as one operating-system-selected bind. Readiness must use the actual URL and a deadline, and it must not make startup depend on browser availability.

- [ ] Step 4: Factor startup into start.ts and preserve development behavior

Move the current top-level startup sequence into startServer. Use the injected or default KeytarKeychain, initialize the MCP token exactly once, pass the asset provider into createServer, call waitForReadiness after listenLoopback, and close Fastify in the returned lifecycle. Keep apps/server/src/index.ts exporting createServer and invoking startServer only when NODE_ENV is not test. Keep THEAIHATCH_AUTO_OPEN=1 as the explicit auto-open switch for development; packaged callers may pass autoOpen: true.

- [ ] Step 5: Run server regressions and typecheck

Run:

~~~
npm exec vitest run apps/server/test/bootstrap.test.ts apps/server/test/start.test.ts apps/server/test/assets.test.ts apps/server/test/agent-routes.test.ts apps/server/test/workspace-terminal.test.ts
npm run typecheck
~~~

Expected: all selected tests pass and the existing server route contract is unchanged.

- [ ] Step 6: Commit startup lifecycle

~~~
git add apps/server/src/bootstrap/listen.ts apps/server/src/bootstrap/start.ts apps/server/src/index.ts apps/server/test/bootstrap.test.ts apps/server/test/start.test.ts
git commit -m "feat(server): add ready loopback startup lifecycle"
~~~

### Task 5: Harden signed release metadata checks

**Files:**
- Modify: apps/server/src/updates/check.ts
- Create: apps/server/test/updates.test.ts
- Modify: apps/server/test/bootstrap.test.ts

**Interfaces:**
- ReleaseTargetMetadata is { target: ReleaseTarget; url: string; sha256: string }.
- ReleaseMetadata is { schemaVersion: 1; version: string; url: string; targets: readonly ReleaseTargetMetadata[]; signature: string; signedPayload: string }.
- canonicalReleasePayload(input: Pick<ReleaseMetadata, "schemaVersion" | "version" | "url" | "targets">): string returns stable JSON with target entries sorted by target name.
- verifyReleaseMetadata(metadata: ReleaseMetadata, publicKey: string): boolean verifies a SHA-256 signature over the canonical payload and confirms the signed fields equal the top-level fields.
- isNewerVersion(currentVersion: string, candidateVersion: string): boolean compares strict major.minor.patch versions and rejects malformed versions.
- UpdateChecker exposes shouldCheck(now?: number): boolean and markChecked(now?: number): void; its initial timestamp is null, and failed attempts still count as checked.
- checkSignedRelease(url: string, publicKey: string, checker: UpdateChecker, options?: { now?: () => number; fetcher?: typeof fetch; timeoutMs?: number; currentVersion?: string }): Promise<ReleaseMetadata | null> validates URL, fetches with an abort deadline, verifies metadata, applies rate limiting, and returns only a valid newer release.

- [ ] Step 1: Write failing signature, URL, timeout, newer-version, and rate-limit tests

Generate an RSA keypair in the test, sign canonicalReleasePayload, and cover valid metadata, a changed URL, changed target digest, malformed payload, http URL rejection, invalid signature, offline fetch, timeout, and a failed attempt suppressing the next check. Assert that a candidate equal to currentVersion is not reported.

~~~
it("REQ-PKG-006: binds the signature to the release fields", async () => {
  const signed = signRelease({ version: "0.2.0", url: "https://updates.test/release.json", targets });
  const altered = { ...signed, url: "https://updates.test/other.json" };
  expect(verifyReleaseMetadata(signed, publicKey)).toBe(true);
  expect(verifyReleaseMetadata(altered, publicKey)).toBe(false);
});
~~~

- [ ] Step 2: Run focused tests and verify failure

Run: npm exec vitest run apps/server/test/updates.test.ts apps/server/test/bootstrap.test.ts

Expected: FAIL because the current schema has no target binding, accepts unsigned-field changes, and marks only successful checks.

- [ ] Step 3: Implement canonical payload and fail-closed checks

Parse the signed payload as JSON, compare its exact canonical serialization with canonicalReleasePayload, require https URLs, require target digests to be non-empty SHA-256 hex strings, and catch all fetch/parse/crypto errors as null. Mark the attempt in a finally block after the rate-limit decision. Use AbortController for the timeout and do not expose response bodies in errors.

- [ ] Step 4: Run update and full server tests

Run: npm exec vitest run apps/server/test/updates.test.ts apps/server/test/bootstrap.test.ts apps/server/test/start.test.ts

Expected: all tests pass.

- [ ] Step 5: Commit signed update verification

~~~
git add apps/server/src/updates/check.ts apps/server/test/updates.test.ts apps/server/test/bootstrap.test.ts
git commit -m "feat(updates): verify rate-limited signed release metadata"
~~~

### Task 6: Build the server launcher and inject Node SEA artifacts

**Files:**
- Create: apps/server/src/sea-entry.ts
- Modify: apps/server/src/bootstrap/assets.ts
- Modify: apps/server/src/bootstrap/start.ts
- Create: packages/packaging/src/sea.ts
- Create: packages/packaging/src/cli.ts
- Create: packages/packaging/test/sea.test.ts
- Modify: packages/packaging/src/build.ts
- Modify: packages/packaging/src/index.ts
- Modify: package.json
- Modify: package-lock.json

**Interfaces:**
- createPackagedAssetProvider(): Promise<AssetProvider> reads SEA assets through a narrow injected getAsset function and never falls back to the repository filesystem.
- BundleOptions is { projectRoot: string; outputDirectory: string }.
- BundleResult is { launcherPath: string; assetDirectory: string; nativeAssets: readonly NativeAddonAsset[]; embeddedAssetSha256: string }.
- bundleServer(options: BundleOptions): Promise<BundleResult> creates a single launcher bundle with native package runtime inputs explicitly externalized and asset keys matching seaBuildPlan.
- SeaCommandOptions is { projectRoot: string; target: ReleaseTarget; releaseVersion: string; outputDirectory: string }.
- buildPackage(options: SeaCommandOptions): Promise<ArtifactManifest> builds the web assets, bundles the launcher, generates the SEA blob, injects it into a host-matching Node runtime, verifies the final executable, and writes the manifest/checksum.
- buildPlan(target, releaseVersion, projectRoot): Promise<PackageLayout> returns a plan without performing injection.

- [ ] Step 1: Add a minimal SEA feasibility test before the full build

Create a test fixture launcher that loads the packaged runtime asset map and attempts to import both better-sqlite3 and keytar from the extracted runtime cache. Run it through the Node SEA preparation/injection commands on the current host. The test must either execute successfully with no repository node_modules lookup or fail with a diagnostic identifying the native package and the missing runtime asset. Do not weaken the assertion by allowing a fallback to the repository.

- [ ] Step 2: Run the feasibility test and verify failure

Run: npm exec vitest run packages/packaging/test/sea.test.ts

Expected: the test initially fails because no launcher, asset extraction, or SEA command exists. If the first implementation attempt cannot load a native module from the single executable, stop this task, preserve the failing diagnostic, and revise the Phase 6A design before proceeding; do not ship an adjacent-resource workaround.

- [ ] Step 3: Add direct build tools and create the packaged entrypoint

Add direct development dependencies esbuild@^0.28.2 and postject@^1.0.0-alpha.6. Create sea-entry.ts that constructs the embedded asset provider, calls startServer with the asset provider and autoOpen set to process.env.THEAIHATCH_AUTO_OPEN !== "0", and keeps the returned lifecycle alive until SIGINT/SIGTERM. The entrypoint must not import Vite or read process.cwd() for application assets.

- [ ] Step 4: Implement the deterministic server bundle

Use esbuild with platform node, a fixed target of node22, and an explicit entrypoint of apps/server/src/sea-entry.ts. Bundle JavaScript dependencies into the launcher. Treat native packages as named runtime assets and preserve their package-relative runtime layout in the extracted cache. Hash the complete embedded asset map in sorted key order before writing the SEA config.

- [ ] Step 5: Implement host-native SEA preparation and injection

Build apps/web before bundling. Generate the Node SEA config with absolute paths and the asset map, run node --experimental-sea-config, copy process.execPath to the target output name, and inject the blob using postject with the Node SEA sentinel NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2. Refuse a target whose OS/architecture does not match the current host; cross-target artifact production belongs to the native CI matrix. After injection, read the final executable and write ArtifactManifest and its checksum.

- [ ] Step 6: Add package CLI scripts and deterministic plan tests

Add these root scripts:

~~~
{
  "package:plan": "vite-node --script packages/packaging/src/cli.ts plan",
  "package:build": "vite-node --script packages/packaging/src/cli.ts build"
}
~~~

The plan command prints JSON for one target and version; the build command requires THEAIHATCH_TARGET, accepts THEAIHATCH_VERSION and THEAIHATCH_OUTPUT, and exits nonzero on an unsupported host or unresolved native input. Add tests for stable asset-key ordering, final-executable hashing, and rejection of a target/host mismatch.

- [ ] Step 7: Run build and focused packaging verification

Run:

~~~
npm run build
npm run package:plan -- --target linux-x64 --version 0.1.0
npm exec vitest run packages/packaging/test/*.test.ts
npm run typecheck
~~~

Expected: web build, plan output, packaging tests, and typecheck pass. A host-matching package:build must produce one executable plus manifest and checksum in a temporary output directory.

- [ ] Step 8: Commit the SEA builder

~~~
git add apps/server/src/sea-entry.ts packages/packaging package.json package-lock.json
git commit -m "feat(packaging): build host-native SEA artifacts"
~~~

### Task 7: Add executable smoke coverage and update the phase plan

**Files:**
- Create: packages/packaging/src/smoke.ts
- Create: packages/packaging/test/smoke-runner.test.ts
- Modify: packages/packaging/src/index.ts
- Modify: package.json
- Modify: docs/plan.md

**Interfaces:**
- SmokeOptions is { executable: string; dataDirectory: string; expectedVersion?: string; timeoutMs?: number }.
- runPackageSmoke(options: SmokeOptions): Promise<{ healthStatus: number; rootStatus: number; stderr: string }> launches the executable with THEAIHATCH_AUTO_OPEN=0, isolated data/config paths, and update checks disabled, then verifies /health and / before sending a clean termination signal.
- The smoke runner rejects output that contains a repository-relative asset path, a Node child-process invocation, or a read from the repository node_modules directory.

- [ ] Step 1: Write failing smoke-runner tests

Use a fixture executable script in the test to model successful health/root responses and a fixture that reports an attempted Node or node_modules fallback. Assert that timeout and nonzero exit are reported with the executable path but without environment secrets.

- [ ] Step 2: Run the focused test and verify failure

Run: npm exec vitest run packages/packaging/test/smoke-runner.test.ts

Expected: FAIL because no smoke runner exists.

- [ ] Step 3: Implement clean-environment process management

Spawn the executable with an isolated temporary data directory, THEAIHATCH_AUTO_OPEN=0, THEAIHATCH_UPDATE_URL=, and an explicit port of 0. Poll the child's /health, fetch /, record only bounded stderr, terminate with SIGINT, and force-kill after the timeout. Do not mutate the repository or remove user files.

Add the root package:smoke script at this point:

~~~json
{
  "package:smoke": "vite-node --script packages/packaging/src/smoke.ts"
}
~~~

- [ ] Step 4: Run the host-native artifact smoke test

Run:

~~~
npm run package:build
npm run package:smoke -- --executable <host-artifact-path>
~~~

Expected: the artifact starts from an isolated directory, returns 200 for /health and /, and exits cleanly without using a separate Node runtime or repository assets.

- [ ] Step 5: Run the complete Phase 6A verification gate

Run:

~~~
npm run typecheck
npm run lint
npm test
npm run build
npm exec vitest run packages/packaging/test/*.test.ts apps/server/test/assets.test.ts apps/server/test/bootstrap.test.ts apps/server/test/start.test.ts apps/server/test/updates.test.ts
~~~

Expected: all commands pass. The first full run that reports an unhandled asynchronous watcher error must be repeated once; a second failure is a blocker requiring investigation before completion.

- [ ] Step 6: Mark only completed Phase 6A tasks in docs/plan.md

Change the checkboxes for the packaging build, first-run, loopback startup, signed update, and package smoke tasks to [x]. Leave the Phase 6B open-source and release-automation tasks unchecked. Add a short note beneath Phase 6 stating that release publication remains Phase 6B and that native smoke runs on each target's native CI runner.

- [ ] Step 7: Commit smoke verification and plan tracking

~~~
git add packages/packaging docs/plan.md
git commit -m "test(packaging): verify native artifact startup"
~~~

## Plan self-review

- Spec coverage: packaging contracts/native feasibility (Task 1), embedded assets (Task 2), atomic first-run/storage (Task 3), loopback/readiness/browser lifecycle (Task 4), signed updates (Task 5), SEA build/injection/manifests (Task 6), and clean-machine smoke/plan tracking (Task 7) are all mapped.
- Scope: release workflows, semantic-release, signing keys, documentation, and community files are explicitly deferred to Phase 6B.
- Placeholder scan: no TBD, TODO, or unspecified implementation step is required; the native feasibility condition is an explicit gate with a defined stop/revise outcome.
- Type consistency: AssetProvider is produced by Task 2 and consumed by Tasks 4 and 6; ArtifactManifest and NativeAddonAsset are produced by Task 1 and consumed by Tasks 6 and 7; startServer is produced by Task 4 and consumed by index.ts and sea-entry.ts in Task 6.
- Verification: every task has a red test, focused green test, regression command, and commit checkpoint.
