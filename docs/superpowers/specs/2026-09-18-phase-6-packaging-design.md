# Phase 6A Packaging Foundation Design

## Status

Proposed design for the first sub-phase of Phase 6, approved in chat at the scope level. This sub-phase establishes the packaged runtime and its verification boundary. Release automation and open-source process files remain Phase 6B.

### Task 6 feasibility gate: initial failure and recovery, 2026-09-18

The first Windows x64 Node 22.23.2 prototype successfully prepared and injected
a SEA with postject 1.0.0-alpha.6, then failed the native loading gate. After
relocating only the executable and removing its build inputs, better-sqlite3's
`bindings` wrapper requested `node_modules/better-sqlite3/build/better_sqlite3.node`.
The embedded inventory contains the actual binary at
`node_modules/better-sqlite3/build/Release/better_sqlite3.node`. The prototype's
closed inventory loader threw a generic missing-asset error for the first probe;
`bindings` expects `MODULE_NOT_FOUND` to continue to subsequent candidates.

Full builder implementation was halted under Task 6's binding first-attempt gate.
This is an identified prototype resolver incompatibility, not evidence that SEA
cannot load native addons. That attempt produced no release artifact or manifest.

Required design correction before resuming:

- Explicit runtime inputs must include package metadata, JavaScript wrappers,
  native binaries and the runtime dependency closure (`bindings` and
  `file-uri-to-path` for the current SQLite wrapper), preserving relative paths.
- An inventory-only loader must preserve CommonJS resolution error semantics for
  absent probe candidates while forbidding all ambient repository resolution.
  Only exhaustion of valid candidates should produce the final diagnostic naming
  the native package and missing runtime input. No repository or adjacent-resource
  fallback is permitted.
- Test the resolver contract independently, then rerun the unchanged native
  success requirement in an injected executable before implementing the full
  server builder. Both packages must be attempted even if one fails.
- Use the same Node 22 executable for preparation and injection, and native
  binaries built for its ABI. The local default Node 24 binary's SQLite ABI 137
  does not match Node 22's ABI 127.

The authorized recovery implemented and tested this correction. The unchanged
Windows x64 Node 22.23.2 SEA gate now passes: it relocates only the executable,
deletes build inputs, clears PATH/NODE_PATH/NODE_OPTIONS, executes SQLite
`SELECT 42`, and loads keytar. The original failed-attempt report is retained.

The recovered builder additionally verifies the actual bundled server, native
modules, storage initialization, loopback health and embedded UI before writing
a final-byte manifest. Its verification mode uses temporary storage and an
in-memory keychain to avoid touching user credentials; normal packaged startup
retains the production keychain. Extracted runtime files are published atomically
into the hash-addressed cache, checked for integrity, and symlinked cache
directories are rejected. Concurrent fresh-cache launches are covered on this
host. macOS/Linux native execution remains a native CI responsibility.

## Goal

Produce a reproducible Node SEA-based application payload that embeds the built web UI and server launcher, starts the existing Fastify application on loopback, survives first-run interruption, and can verify signed release metadata without downloading or installing updates.

The packaged application must preserve the existing development path. Development continues to use Vite and source files; the packaged path supplies an asset provider and launcher configuration without changing workspace, agent, safety, review, or MCP behavior.

## Scope

### Included

- A deterministic packaging layout and Node SEA configuration for `windows-x64`, `macos-arm64`, and `linux-x64`.
- A production launcher that supplies the built web assets to the server and starts the same Fastify route composition used by development.
- A safe static asset boundary with SPA fallback and traversal protection.
- Platform-specific config and data paths, including test overrides that do not alter production defaults.
- Atomic, resumable first-run state with keychain and storage initialization hooks.
- Actual loopback listen fallback, readiness probing, URL reporting, and optional browser launch.
- Canonical signed release metadata verification, bounded fetch behavior, and once-per-interval checking.
- Artifact manifests and SHA-256 checksums.
- Unit, integration, and host-native package smoke coverage.

### Excluded

- Automatic update installation or replacement of the running executable.
- App-store packaging, installers, notarization, code-signing identity management, and hosted update delivery.
- New provider, workspace, agent, safety, review, or MCP behavior.
- Release workflow changes, semantic-release configuration, contribution documents, and issue templates; those are Phase 6B.

## Design options considered

### Node SEA with an extracted runtime cache (recommended)

Bundle the server launcher and web assets into a Node single executable application. Native modules used by the server (`better-sqlite3` and `keytar`) are treated as explicit packaging inputs. The build either embeds the required native binaries as SEA assets and extracts them to a per-user, hash-addressed runtime cache before loading, or fails with a diagnostic if the target cannot be produced. The executable remains the only distributed payload; extraction is an implementation detail of first launch.

This follows the existing `seaBuildPlan` direction, keeps the release toolchain close to Node 22, and gives the package tests a clear integrity boundary. It also exposes native-addon incompatibilities early instead of hiding them in a release archive.

### External application packager

Adopt a tool such as `pkg` or `nexe` to collect JavaScript, assets, and native modules. This can reduce custom launcher code, but introduces another runtime compatibility layer and uncertain support for the repository's Node 22 and ESM/native-addon combination.

### Runtime plus adjacent resources

Ship a small executable next to an asset directory and native module directory. This is simpler to debug, but does not meet the Phase 6 single-binary acceptance criteria and would make release integrity depend on multiple independently moved files.

The recommended option is Node SEA, with the native-addon feasibility check as the first implementation task and a hard failure rather than a false-positive artifact.

## Architecture

### Packaging layout and launcher

`packages/packaging/src/build.ts` becomes the source of truth for target names, output names, staging paths, asset maps, launcher configuration, and manifest generation. It will expose pure planning functions plus filesystem operations for staging and checksums. All paths written into generated config are absolute and derived from the staging directory; generated output is reproducible for the same source tree and target.

The build sequence is:

1. Build `apps/web` into a clean staging directory.
2. Bundle the server launcher and its statically discoverable JavaScript dependencies for the target runtime.
3. Collect web assets, the launcher, and required native-addon inputs into the SEA asset map.
4. Generate the SEA blob and inject it into the target Node runtime according to the target-specific executable suffix.
5. Run an artifact integrity check and write a manifest containing target, executable name, asset digest, and executable SHA-256.

The launcher will choose an asset provider at runtime. In development it reads `apps/web/dist` or the configured filesystem directory. In a SEA executable it reads the embedded asset map and exposes the same logical paths. Native resources are extracted only to a versioned, hash-addressed cache with restrictive permissions where the platform supports them; stale cache entries are not used when the manifest hash changes.

The build must reject missing web output, missing launcher assets, unsupported targets, and unresolved native modules. It must never emit a manifest for an artifact that was not read successfully after injection.

### Server asset boundary

The server will expose a small asset-serving boundary rather than coupling route code to Vite. The boundary accepts a logical asset path, rejects absolute paths and traversal after normalization, serves known content types, and falls back to `index.html` for browser routes that are not API or health routes. API routes continue to be registered before the fallback.

`createServer` will accept an optional asset provider so existing tests can construct a route-only server. Packaged startup supplies the embedded provider; development can continue to use the Vite proxy or an explicit filesystem provider. No user workspace path is accepted by this provider.

### First-run state

`apps/server/src/bootstrap/first-run.ts` will retain `userPaths()` as the default source of platform locations and add an atomic state machine. The state file records a schema version, data directory, completed initialization steps, and keychain verification result. A temporary file is written, flushed where the platform permits, and renamed into place. A restart reads the last complete step and resumes idempotently; an incomplete temporary file is ignored or recovered according to its valid JSON contents.

Initialization steps are ordered so that directories exist before storage and keychain checks, and the main server is not reported ready until all required steps finish. The function will accept injected storage and keychain callbacks for tests. Existing version-1 state is migrated to the current state shape without rerunning completed work.

### Loopback startup and readiness

The application will attempt to listen on the preferred loopback port and then each port in a bounded fallback range. The actual Fastify listen operation owns the bind attempt; startup will not use a probe-then-close sequence that can race another process. The selected port is returned as part of a launch result and printed in a stable message.

After binding, startup waits for a loopback health request to succeed with a short bounded retry window. Browser launch occurs only after readiness and uses the actual URL. Auto-open is enabled only by explicit packaged-startup configuration, can be disabled by environment/configuration, and never prevents the server from starting when the browser command fails.

The server remains bound to `127.0.0.1`. Shutdown closes Fastify and any extracted-runtime resources through the existing signal path.

### Signed update metadata

`apps/server/src/updates/check.ts` will define a versioned metadata schema whose signed payload canonically binds the release version, release URL, and target metadata. Verification rejects malformed metadata, non-release URLs, mismatched signed fields, invalid signatures, and unsupported versions. Production uses an embedded public verification key; tests inject a generated key.

The checker accepts a clock, fetch implementation, and timeout configuration. It records the time of every attempted check, not only successful checks, so startup can perform at most one attempt per configured interval (24 hours by default). Fetch failures, offline operation, invalid metadata, and signature failures return no update and do not affect local startup. A valid newer release is returned as notification data only; no download or installation is initiated.

### Artifact manifests

The manifest format will be stable JSON with an explicit schema version, target, executable filename, executable SHA-256, embedded asset digest, and release version. Manifest generation reads the final executable bytes, not a pre-injection staging file. A companion checksum file uses the same digest. Signing of release metadata is a release-workflow concern for Phase 6B; the local package builder only produces the unsigned material and verifies its own internal consistency.

## Data flow

```text
source tree
  -> web build + server bundle
  -> target staging directory
  -> SEA asset map + native-module feasibility check
  -> injected target executable
  -> integrity verification + manifest/checksum
  -> clean-machine smoke launch
       -> first-run state/storage/keychain
       -> loopback bind and health readiness
       -> embedded web asset serving
       -> optional browser open
```

The update path is independent of startup success after initialization:

```text
ready server
  -> rate-limit decision
  -> bounded metadata fetch
  -> schema + canonical signature verification
  -> optional newer-release notification
```

## Error handling and security

- Packaging fails closed on unresolved assets, native modules, invalid target configuration, or checksum mismatch.
- Startup stays loopback-only and never binds to an externally reachable interface.
- Asset paths are normalized before lookup; API, health, and filesystem paths cannot fall through to arbitrary files.
- First-run state is never overwritten in place with a partially written JSON document.
- Keychain values, update public keys, and provider credentials are not written into manifests, logs, or SES events.
- Update metadata is fail-closed and never executes content from the release URL.
- Native runtime extraction is hash-addressed and rejects an existing cache file whose digest does not match the packaged asset.
- Browser-open failure is non-fatal; port exhaustion and failed readiness are fatal with an actionable message.

## Verification strategy

### Unit tests

- Build plans contain the complete target matrix, deterministic asset keys, correct executable suffixes, and reject missing inputs.
- SEA config and manifest generation resolve paths correctly and produce stable SHA-256 values.
- Native-addon discovery reports all required inputs and fails clearly when one is unavailable.
- Platform paths resolve correctly for Windows, macOS, and Linux fixtures.
- First-run initialization writes atomically, resumes after each interrupted step, migrates version-1 state, and avoids duplicate keychain/storage work.
- Loopback fallback binds the first available port, reports exhaustion, waits for readiness, and handles browser command failure.
- Static assets serve, SPA fallback works, and traversal/API fallthrough is rejected.
- Update metadata canonicalization, signature verification, URL binding, malformed data, timeout, offline behavior, and rate limiting are covered.

### Integration and package smoke tests

The package smoke suite builds or consumes one native artifact per supported target on its native CI runner. It starts the artifact with isolated platform data/config overrides, disables browser opening, waits for `/health`, loads the fixture-backed web entry point, and terminates it cleanly. The smoke command verifies that the executable does not invoke a separately installed Node binary or read the repository's `node_modules` directory.

The Windows, macOS, and Linux jobs execute the same smoke contract. Cross-target planning tests run on every host; native execution is required on the matching host. This keeps local Windows development useful without pretending that a Windows process can validate a macOS or Linux binary.

## Acceptance criteria

Phase 6A is complete when:

1. Each supported target has a reproducible, integrity-checked executable plan and a native smoke path.
2. A target artifact serves the bundled fixture UI without Node, Vite, or repository-relative asset paths.
3. First-run interruption and restart leave one valid state and initialized storage/keychain boundary.
4. A busy preferred port selects the first available bounded fallback and browser launch receives that actual URL only after health readiness.
5. A valid signed newer release is reportable at most once per interval, while invalid/offline checks leave startup unaffected.
6. Typecheck, lint, unit tests, and package tests pass, with the native smoke contract passing on all three target runners.

## Follow-up boundary

Phase 6B will consume the manifest and checksum contract established here to add semantic-release, signed tags and metadata, per-OS artifact publication, CI secret fixtures, and the remaining documentation/process files. It will not change the packaged runtime interfaces unless Phase 6A's native-addon feasibility gate proves that Node SEA cannot satisfy the single-binary requirement.
