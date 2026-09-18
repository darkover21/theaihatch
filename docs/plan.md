# Implementation plan

## Phase 1 — SES and fixture playback

**Goal:** Animate a hand-written SES fixture through Monaco with complete transport controls and no model or API key.
**Demo:** Open the bundled fixture, watch files open and code type at human speed, pause, change speed, step by event or group, seek backward, and jump to its growing head.
**Requirements covered:** REQ-SES-001, REQ-SES-002, REQ-SES-003, REQ-SES-004, REQ-SES-005, REQ-SES-006, REQ-SES-007, REQ-SES-008, REQ-SES-009, REQ-PLY-001, REQ-PLY-002, REQ-PLY-003, REQ-PLY-004, REQ-PLY-005, REQ-PLY-006, REQ-PLY-007, REQ-TYP-001, REQ-TYP-002, REQ-TYP-003, REQ-TYP-004, REQ-TYP-005, REQ-TYP-006, REQ-STP-001, REQ-STP-002, REQ-STP-003, REQ-STP-004, REQ-STP-005, REQ-EDT-001, REQ-EDT-003, REQ-EDT-004, REQ-EDT-005, REQ-EDT-006

### Tasks
- [ ] Create strict workspace, TypeScript, lint, test, React, Vite, and Tailwind configuration → `package.json`
- [ ] Define the complete SES types and runtime validators → `packages/ses/src/schema.ts`
- [ ] Implement serialized JSONL append and sequence/timestamp validation → `packages/ses/src/writer.ts`
- [ ] Implement byte-offset indexes, range reads, checkpoint lookup, and corruption recovery → `packages/ses/src/reader.ts`
- [ ] Add SQLite session metadata schema and repository → `packages/storage/src/sessions.ts`
- [ ] Implement 500-event checkpoint generation and touched-file projection → `packages/ses/src/checkpoints.ts`
- [ ] Implement playback state reducer and legal transition tests → `packages/playback/src/state-machine.ts`
- [ ] Implement scheduling, speed scaling, stream-follow, behind-live, and jump-to-live → `packages/playback/src/engine.ts`
- [ ] Implement checkpoint restore plus event, step, timeline, and file seeking → `packages/playback/src/seek.ts`
- [ ] Implement explicit and inferred step indexes and labels → `packages/playback/src/steps.ts`
- [ ] Implement seeded character timing, pause classes, thresholds, easing, and scroll targets → `packages/typing/src/scheduler.ts`
- [ ] Build the application shell, Monaco projection, step list, and transport controls → `apps/web/src/App.tsx`
- [ ] Add a hand-written multi-file session with checkpoints and terminal-free steps → `fixtures/sessions/walking-skeleton/events.jsonl`
- [ ] Add browser tests for playback, all navigation modes, speed, seek, corruption, and live catch-up → `apps/web/e2e/fixture-playback.spec.ts`

**Exit criteria**
- A clean machine can run the fixture demo without a provider configuration or API key.
- Seeked state hashes match linear-play state hashes at every fixture checkpoint and target.
- Playback and SES unit/integration suites pass with no dropped or reordered event.

## Phase 2 — Real workspace and terminal

**Goal:** Open a local project and record scripted file and command activity as a replayable SES.
**Demo:** Select a folder, browse decorated files, run the scripted edit/command sequence, watch typed commands and streamed output, then replay it.
**Requirements covered:** REQ-WKS-001, REQ-WKS-002, REQ-WKS-003, REQ-WKS-004, REQ-WKS-005, REQ-WKS-006, REQ-EDT-002, REQ-TRM-001, REQ-TRM-002, REQ-TRM-003, REQ-TRM-004, REQ-TRM-005

### Tasks
- [ ] Implement folder selection and canonical workspace handles → `apps/server/src/routes/workspaces.ts`
- [ ] Implement normalized path containment and lazy ignored file discovery → `packages/workspace/src/tree.ts`
- [ ] Implement `.gitignore`, mandatory ignore rules, and watcher reconciliation → `packages/workspace/src/watcher.ts`
- [ ] Implement Git porcelain status parsing and ancestor decorations → `packages/workspace/src/git-status.ts`
- [ ] Build explorer behavior and external-change conflict prompts → `apps/web/src/features/explorer/Explorer.tsx`
- [ ] Add Monaco model-per-path tabs, dirty state, and view-state restoration → `apps/web/src/features/editor/EditorTabs.tsx`
- [ ] Supervise workspace-rooted child processes and capture ordered output chunks → `apps/server/src/terminal/process-runner.ts`
- [ ] Convert command lifecycle and output into SES events → `apps/server/src/terminal/terminal-recorder.ts`
- [ ] Build the resizable xterm.js panel and exit-state decorations → `apps/web/src/features/terminal/TerminalPanel.tsx`
- [ ] Implement a provider-free scripted edit and command recorder → `apps/server/src/scripts/workspace-demo.ts`
- [ ] Add real-filesystem, watcher, Git-status, terminal, and replay integration tests → `apps/server/test/workspace-terminal.test.ts`

**Exit criteria**
- The demo records and replays file edits and a streamed command with identical final file and terminal state.
- Ignored paths never appear in the explorer, watcher output, or recorded SES.
- Windows, macOS, and Linux path fixtures pass normalization and containment tests.

## Phase 3 — Agent runtime and one provider

**Goal:** Run the provider-neutral agent loop through one selected adapter and render real agent work through SES.
**Demo:** Enter a prompt, watch the agent call file and terminal tools, cancel or let it finish, then inspect tokens, cost, and persisted conversation.
**Requirements covered:** REQ-AGT-001, REQ-AGT-002, REQ-AGT-003, REQ-AGT-004, REQ-AGT-005, REQ-AGT-006, REQ-AGT-007, REQ-AGT-008, REQ-PRV-001, REQ-PRV-006, REQ-PRV-007, REQ-PRV-008, and one of REQ-PRV-002, REQ-PRV-003, or REQ-PRV-004 as resolved in `docs/open-questions.md`

### Tasks
- [ ] Define normalized provider stream, tool call, usage, error, and cancellation contracts → `packages/providers/src/types.ts`
- [ ] Implement deterministic system-prompt composition and precedence tests → `packages/agent/src/system-prompt.ts`
- [ ] Implement the bounded tool-calling loop and conversation state machine → `packages/agent/src/runtime.ts`
- [ ] Implement cancellation propagation, transient retry, backoff, and run limits → `packages/agent/src/control.ts`
- [ ] Persist conversations, runs, messages, usage, and estimated cost → `packages/storage/src/conversations.ts`
- [ ] Implement the selected Phase 3 provider adapter → `packages/providers/src/phase3-adapter.ts`
- [ ] Integrate OS-keychain secret storage without secret serialization → `apps/server/src/secrets/keychain.ts`
- [ ] Build provider/model selection, credentials, and bounded connection test UI → `apps/web/src/features/providers/ProviderSettings.tsx`
- [ ] Map agent/tool streaming to explicit steps and granular SES edits → `apps/server/src/agent/ses-recorder.ts`
- [ ] Build prompt, run-state, cancellation, usage, and cost UI → `apps/web/src/features/agent/RunPanel.tsx`
- [ ] Add fake-provider contract tests and a live-adapter opt-in smoke test → `packages/agent/test/runtime.test.ts`

**Exit criteria**
- A real prompt through the selected adapter produces watchable, replayable edits and command output.
- Cancellation stops model and command activity and closes the SES step as cancelled.
- Restarting the app restores the conversation and exact usage totals without persisting the API key outside the keychain.

## Phase 4 — Providers and MCP

**Goal:** Complete model-provider coverage and support MCP in both independent directions.
**Demo:** Switch among configured providers, call tools from two isolated outbound MCP servers, then drive the animation from an authenticated external MCP client.
**Requirements covered:** REQ-PRV-002, REQ-PRV-003, REQ-PRV-004, REQ-PRV-005, REQ-MPC-001, REQ-MPC-002, REQ-MPC-003, REQ-MPC-004, REQ-MPC-005, REQ-MPC-006, REQ-MPS-001, REQ-MPS-002, REQ-MPS-003, REQ-MPS-004, REQ-MPS-005

### Tasks
- [ ] Implement Anthropic streaming, tool use, usage, and error normalization → `packages/providers/src/anthropic.ts`
- [ ] Implement OpenAI streaming, parallel tool calls, usage, and error normalization → `packages/providers/src/openai.ts`
- [ ] Implement Gemini streaming, function calls, safety outcomes, and usage normalization → `packages/providers/src/gemini.ts`
- [ ] Implement configurable OpenAI-compatible base URL, headers, key, and manual model → `packages/providers/src/openai-compatible.ts`
- [ ] Run all adapters through the shared contract suite → `packages/providers/test/contract.test.ts`
- [ ] Implement stdio and streamable HTTP MCP client transports → `packages/mcp-client/src/transports.ts`
- [ ] Implement discovery, qualified capability registry, refresh, timeout, and isolation → `packages/mcp-client/src/registry.ts`
- [ ] Implement per-tool approval policy and argument validation → `packages/mcp-client/src/tool-policy.ts`
- [ ] Build MCP server/tool configuration, status, schema, and policy UI → `apps/web/src/features/mcp/McpPanel.tsx`
- [ ] Implement loopback streamable HTTP MCP endpoint and bearer authentication → `packages/mcp-server/src/server.ts`
- [ ] Implement the mutation control lease and five platform tool schemas → `packages/mcp-server/src/tools.ts`
- [ ] Route inbound calls through platform services and SES recording → `apps/server/src/mcp/inbound-controller.ts`
- [ ] Add two-server failure-isolation and external-driver end-to-end tests → `apps/server/test/mcp.e2e.test.ts`

**Exit criteria**
- The same agent contract test passes for all four adapter types.
- A crashing outbound MCP server does not interrupt another server or the active run.
- An authenticated loopback client drives a visible edit and command; non-loopback and invalid-token requests fail.

## Phase 5 — Safety, checkpoints, and review

**Goal:** Make agent work confined, reversible, dry-runnable, and gated by hunk-level human review.
**Demo:** Start from a dirty Git workspace, create an automatic checkpoint, preview a dry run, reject one hunk with feedback, approve another, and revert the run in one action.
**Requirements covered:** REQ-MPS-006, REQ-SAF-001, REQ-SAF-002, REQ-SAF-003, REQ-SAF-004, REQ-SAF-005, REQ-SAF-006, REQ-SAF-007, REQ-REV-001, REQ-REV-002, REQ-REV-003, REQ-REV-004, REQ-REV-005, REQ-REV-006

### Tasks
- [ ] Implement canonical path allowlisting with symlink and traversal defense → `packages/safety/src/path-policy.ts`
- [ ] Implement non-branch-changing Git checkpoints for tracked, staged, untracked, and deleted state → `packages/safety/src/git-checkpoint.ts`
- [ ] Implement recovery checkpoint plus confirmed one-click revert → `packages/safety/src/revert.ts`
- [ ] Implement destructive-command classification and exact-command confirmation → `packages/safety/src/command-policy.ts`
- [ ] Enforce workspace-root shell working directories → `packages/safety/src/shell-policy.ts`
- [ ] Implement dry-run interception and proposed-action SES projection → `packages/safety/src/dry-run.ts`
- [ ] Apply path, command, dry-run, and review gates to inbound MCP tools → `apps/server/src/mcp/inbound-policy.ts`
- [ ] Persist redacted safety decisions and checkpoint records → `packages/storage/src/safety-audit.ts`
- [ ] Compute stable file/hunk diffs and fingerprints → `packages/review/src/diff.ts`
- [ ] Apply independent accept/reject decisions with stale-hunk detection → `packages/review/src/apply.ts`
- [ ] Implement review gate and structured rejection feedback in the agent loop → `packages/agent/src/review-gate.ts`
- [x] Build diff review, hunk actions, feedback, and event-seek links → `apps/web/src/features/review/ReviewPanel.tsx`
- [ ] Add escape, dirty-checkpoint, revert, destructive-command, dry-run, and mixed-hunk end-to-end tests → `apps/server/test/safety-review.e2e.test.ts`

**Exit criteria**
- Path, symlink, and shell attempts outside the workspace are rejected before mutation or process creation.
- A checkpoint round trip restores tracked, staged, untracked, and deleted fixture state byte-for-byte.
- The agent cannot continue across a review gate until all hunks resolve, and rejection feedback appears exactly once in its next turn.

## Phase 6 — Packaging and open-source release

**Goal:** Publish reproducible single-binary releases and a contribution-ready Apache-2.0 repository.
**Demo:** Download a clean-machine artifact on each OS, complete first run, auto-open the browser on a fallback port, replay the fixture, and receive a signed update notification.
**Requirements covered:** REQ-PKG-001, REQ-PKG-002, REQ-PKG-003, REQ-PKG-004, REQ-PKG-005, REQ-PKG-006, REQ-OSS-001, REQ-OSS-002, REQ-OSS-003, REQ-OSS-004, REQ-OSS-005, REQ-OSS-006, REQ-OSS-007, REQ-OSS-008

### Tasks
- [ ] Embed server and web assets into the self-contained executable build → `packages/packaging/src/build.ts`
- [ ] Implement platform config/data paths and resumable first-run initialization → `apps/server/src/bootstrap/first-run.ts`
- [ ] Implement bounded loopback port fallback, readiness, and browser launch → `apps/server/src/bootstrap/listen.ts`
- [ ] Implement rate-limited signed release metadata checks → `apps/server/src/updates/check.ts`
- [ ] Add clean-machine package smoke tests for all release targets → `packages/packaging/test/smoke.test.ts`
- [ ] Add canonical Apache-2.0 license and package metadata → `LICENSE`
- [ ] Write install, development, security, and usage documentation with animation GIF → `README.md`
- [ ] Add contribution and conduct processes → `CONTRIBUTING.md`
- [ ] Add code of conduct and enforcement contact → `CODE_OF_CONDUCT.md`
- [ ] Add bug, feature, and pull-request templates → `.github/ISSUE_TEMPLATE/bug.yml`
- [ ] Add supported-version and private-reporting policy → `SECURITY.md`
- [ ] Configure Windows, macOS, and Linux build/test/package matrix → `.github/workflows/ci.yml`
- [ ] Configure semantic-release, signed tags, changelog, artifacts, and checksums → `.github/workflows/release.yml`
- [ ] Configure CI secret scanning with synthetic detection fixture → `.github/workflows/secret-scan.yml`

**Exit criteria**
- Each target artifact runs the Phase 1 fixture on a clean machine without Node installed.
- CI passes typecheck, lint, unit, integration, and package smoke suites on Windows, macOS, and Linux.
- A dry-run release produces the expected semantic version, changelog, signed metadata, checksums, and three OS artifacts without publishing secrets.
