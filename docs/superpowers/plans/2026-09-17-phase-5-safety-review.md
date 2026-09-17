# Phase 5 Safety and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local agent and inbound MCP mutations reversible, policy-gated, dry-runnable, and reviewable without changing the default agent-run behavior.

**Architecture:** An in-process server `RunCoordinator` owns each background agent run and exposes its state through polling endpoints. A shared approval broker and guarded workspace-tool layer enforce path, command, dry-run, and review policy for both agent and inbound MCP calls; immutable review snapshots and redacted safety records persist in SQLite.

**Tech Stack:** Node 22, TypeScript strict ESM, Fastify, React 18, Vitest, Playwright, better-sqlite3, existing `@theaihatch/{agent,review,safety,ses,storage,workspace}` packages.

**Spec:** `docs/superpowers/specs/2026-09-17-phase-5-safety-review-design.md`; `docs/specs/safety-and-checkpoints.md`; `docs/specs/review-and-approval.md`; `docs/specs/mcp-server.md`

## Global Constraints

- Preserve the existing default: `reviewMode` and `dryRun` are `false` unless explicitly selected for a run.
- Do not add runtime dependencies, WebSockets, hosted services, or an OS sandbox.
- Store provider keys and MCP bearer tokens only in the OS keychain; never include them in JSONL, SQLite, logs, API responses, or tests.
- Resolve agent and inbound-MCP filesystem paths through `createPathPolicy`; confine shell working directories through `createShellPolicy`.
- Create the Git checkpoint before a provider request or any mutable tool action.
- Use SES `diff_marker`, `agent_tool_call`, `agent_tool_result`, and `error` events; do not add a new SES event type for dry-run metadata.
- Run `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` before the final Phase 5 commit.

---

## File structure

- Create `packages/storage/src/reviews.ts`: immutable review snapshots, hunk decisions, and checkpoint records.
- Modify `packages/storage/src/safety-audit.ts`: redact secret-like values before persistence.
- Create `apps/server/src/agent/approval-broker.ts`: one pending review or destructive-command request per operation, with explicit resolution and cancellation.
- Create `apps/server/src/agent/guarded-tools.ts`: safe proposal/commit wrappers around workspace file and command actions.
- Create `apps/server/src/agent/run-coordinator.ts`: background agent-run lifecycle, status projection, and persistence.
- Modify `apps/server/src/routes/agent.ts`: start/status/review/approval/revert endpoints and provider construction reuse.
- Modify `apps/server/src/mcp/inbound-controller.ts`: use guarded tools and the shared approval broker instead of direct filesystem/process operations.
- Modify `packages/agent/src/review-gate.ts` and `packages/agent/src/runtime.ts`: consume resolved feedback once even when the tool wrapper has already awaited the gate.
- Modify `apps/web/src/features/agent/RunPanel.tsx`, `apps/web/src/features/review/ReviewPanel.tsx`, and `apps/web/src/App.tsx`: per-run controls, polling, pending approval UI, and review submission.
- Create focused unit and integration tests in `packages/storage/test/`, `apps/server/test/`, `packages/agent/test/`, and `apps/web/e2e/`.

### Task 1: Persist immutable review and redacted safety records

**Files:**
- Create: `packages/storage/src/reviews.ts`
- Create: `packages/storage/test/reviews.test.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/src/safety-audit.ts`
- Modify: `packages/storage/test/conversations.test.ts`

**Interfaces:**
- Consumes: `ReviewHunk` from `@theaihatch/review` and `GitCheckpoint` identity from `@theaihatch/safety`.
- Produces: `ReviewRepository.createSnapshot`, `ReviewRepository.resolveSnapshot`, `ReviewRepository.listSnapshots`, `ReviewRepository.recordCheckpoint`, and `SafetyAuditRepository.record` with redacted `detail`.

- [ ] **Step 1: Write the failing review-history and redaction tests**

```ts
it("REQ-REV-006: returns frozen hunk content after workspace bytes change", () => {
  const snapshot = repository.createSnapshot({ runId: "run-1", checkpointId: "cp-1", files: [fileDiff] });
  repository.resolveSnapshot(snapshot.id, [{ hunkId: fileDiff.hunks[0]!.id, decision: "rejected", actor: "local", feedback: "keep API" }]);
  expect(repository.listSnapshots("run-1")[0]?.files[0]?.after).toBe("proposed");
});

it("REQ-SAF-007: redacts configured secret values", () => {
  audit.record({ runId: "run-1", action: "path", decision: "denied", detail: JSON.stringify({ key: "secret-value" }) });
  expect(audit.list("run-1")[0]?.detail).not.toContain("secret-value");
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npx vitest run packages/storage/test/reviews.test.ts`

Expected: FAIL because `ReviewRepository` is not exported.

- [ ] **Step 3: Implement immutable snapshot tables and repository**

```ts
export interface StoredReviewSnapshot { id: string; runId: string; checkpointId: string; createdAt: string; files: FileDiff[]; decisions: StoredReviewDecision[]; }
export class ReviewRepository {
  createSnapshot(input: Omit<StoredReviewSnapshot, "id" | "createdAt" | "decisions">): StoredReviewSnapshot;
  resolveSnapshot(id: string, decisions: readonly StoredReviewDecisionInput[]): StoredReviewSnapshot;
  listSnapshots(runId: string): StoredReviewSnapshot[];
  recordCheckpoint(input: { runId: string; checkpointId: string; kind: "run" | "recovery" | "revert"; createdAt?: string }): void;
}
```

Store `before`, `after`, `binary`, hunks, and hunk fingerprints as JSON in a snapshot row; store decisions independently with their actor, timestamp, and feedback. Add a `redactDetail(detail: string, forbiddenValues: readonly string[])` helper that replaces supplied key values and the JSON keys `apiKey`, `secret`, `token`, and `authorization` before an audit row is inserted.

- [ ] **Step 4: Run focused storage tests and the package test suite**

Run: `npx vitest run packages/storage/test/reviews.test.ts packages/storage/test/conversations.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the persistence boundary**

```bash
git add packages/storage
git commit -m "feat(storage): persist review history and safety audits"
```

### Task 2: Add cancellable local approval coordination

**Files:**
- Create: `apps/server/src/agent/approval-broker.ts`
- Create: `apps/server/test/approval-broker.test.ts`
- Modify: `packages/agent/src/review-gate.ts`
- Modify: `packages/agent/src/runtime.ts`
- Modify: `packages/agent/test/runtime.test.ts`

**Interfaces:**
- Consumes: `ReviewFeedback` and `ReviewGate` from `@theaihatch/agent`, plus `CommandDecision` from `@theaihatch/safety`.
- Produces: `ApprovalBroker.requestReview`, `ApprovalBroker.requestCommand`, `ApprovalBroker.resolveReview`, `ApprovalBroker.resolveCommand`, `ApprovalBroker.cancel`, and `ApprovalBroker.pending`.

- [ ] **Step 1: Write failing approval and feedback-once tests**

```ts
it("REQ-REV-003: waits until every current hunk is resolved", async () => {
  const wait = broker.requestReview({ operationId: "run-1", snapshotId: "snapshot-1", hunks });
  expect(broker.pending("run-1")?.kind).toBe("review");
  broker.resolveReview("run-1", decisions);
  await expect(wait).resolves.toEqual(decisions);
});

it("REQ-SAF-004: a denied exact command resolves to denial without a process", async () => {
  const wait = broker.requestCommand({ operationId: "run-1", decision });
  broker.resolveCommand("run-1", { command: decision.exactCommand, cwd: decision.cwd, approved: false });
  await expect(wait).resolves.toMatchObject({ approved: false });
});
```

- [ ] **Step 2: Run the broker and agent tests to verify failure**

Run: `npx vitest run apps/server/test/approval-broker.test.ts packages/agent/test/runtime.test.ts`

Expected: FAIL because `ApprovalBroker` does not exist.

- [ ] **Step 3: Implement a single-pending-request broker and feedback consumption**

```ts
export type PendingApproval =
  | { kind: "review"; operationId: string; snapshotId: string; hunks: ReviewHunk[] }
  | { kind: "command"; operationId: string; decision: CommandDecision };

export class ApprovalBroker {
  requestReview(input: Extract<PendingApproval, { kind: "review" }>): Promise<StoredReviewDecisionInput[]>;
  requestCommand(input: Extract<PendingApproval, { kind: "command" }>): Promise<{ approved: boolean }>;
  pending(operationId: string): PendingApproval | null;
  resolveReview(operationId: string, decisions: readonly StoredReviewDecisionInput[]): void;
  resolveCommand(operationId: string, input: { approved: boolean; command: string; cwd: string }): void;
  cancel(operationId: string, reason: string): void;
}
```

Make `ReviewGate.wait()` abort-aware and alter the runtime turn tail to call `consumeFeedback()` after either waiting or finding the gate already resolved. This guarantees rejected feedback enters exactly one subsequent provider message.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run apps/server/test/approval-broker.test.ts packages/agent/test/runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the approval boundary**

```bash
git add apps/server/src/agent/approval-broker.ts apps/server/test/approval-broker.test.ts packages/agent
git commit -m "feat(agent): coordinate review and command approvals"
```

### Task 3: Build guarded workspace-tool proposals and commits

**Files:**
- Create: `apps/server/src/agent/guarded-tools.ts`
- Create: `apps/server/test/guarded-tools.test.ts`
- Modify: `apps/server/src/agent/ses-recorder.ts`
- Modify: `apps/server/src/mcp/inbound-policy.ts`

**Interfaces:**
- Consumes: `WorkspaceTree`, `SesWriter`, `ApprovalBroker`, `ReviewRepository`, `SafetyAuditRepository`, `DryRunRecorder`, and `ReviewGate`.
- Produces: `createGuardedWorkspaceTools(input): AgentTool[]` and `GuardedToolContext`.

- [ ] **Step 1: Write failing guard tests for all mutation paths**

```ts
it("REQ-SAF-006: dry-run edit emits a proposed diff without changing bytes", async () => {
  const tools = await createGuardedWorkspaceTools({ ...context, dryRun: true });
  await tools.find((tool) => tool.name === "edit_file")!.execute({ path: "a.ts", content: "after" }, signal);
  expect(await tree.readFile("a.ts")).toBe("before");
  expect(proposals.actions).toEqual([expect.objectContaining({ kind: "file", path: "a.ts" })]);
});

it("REQ-SAF-005: rejects a command cwd outside the workspace before spawning", async () => {
  await expect(runCommand({ command: "echo x", cwd: "../outside" })).resolves.toMatchObject({ ok: false, errorCode: "path_denied" });
  expect(processRunner.calls).toHaveLength(0);
});
```

- [ ] **Step 2: Run the new guard test and verify failure**

Run: `npx vitest run apps/server/test/guarded-tools.test.ts`

Expected: FAIL because guarded tools are not defined.

- [ ] **Step 3: Extract proposal and commit primitives from SES recording**

```ts
export interface GuardedToolContext {
  operationId: string; tree: WorkspaceTree; writer: SesWriter; dryRun: boolean; reviewMode: boolean;
  approvals: ApprovalBroker; reviews: ReviewRepository; audits: SafetyAuditRepository; reviewGate: ReviewGate;
}
export async function createGuardedWorkspaceTools(context: GuardedToolContext): Promise<AgentTool[]>;
```

For `edit_file`, canonicalize the path, read stable `before` content, construct `diffFile`, persist a snapshot when review mode is enabled, append its `diff_marker` ranges, await accepted/rejected decisions, write only accepted content, and return rejected feedback as a normal denied tool result. In dry-run, record the proposal and return it without `tree.writeFile`. For `run_command`, resolve the cwd using `createShellPolicy`, classify it, await the broker only when destructive, and suppress spawning in dry-run. Record every deny, approval, and suppression through the audit repository.

- [ ] **Step 4: Run guarded-tool tests and existing terminal integration tests**

Run: `npx vitest run apps/server/test/guarded-tools.test.ts apps/server/test/workspace-terminal.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit guarded action handling**

```bash
git add apps/server/src/agent/guarded-tools.ts apps/server/src/agent/ses-recorder.ts apps/server/src/mcp/inbound-policy.ts apps/server/test/guarded-tools.test.ts
git commit -m "feat(safety): gate agent workspace mutations"
```

### Task 4: Coordinate background runs and durable lifecycle state

**Files:**
- Create: `apps/server/src/agent/run-coordinator.ts`
- Create: `apps/server/test/run-coordinator.test.ts`
- Modify: `apps/server/src/routes/agent.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- Consumes: `ProviderAdapter`, `AgentRuntime`, guarded tool context, `ConversationRepository`, `ReviewRepository`, `SafetyAuditRepository`, and `GitCheckpointStore`.
- Produces: `RunCoordinator.start`, `RunCoordinator.get`, `RunCoordinator.resolveReview`, `RunCoordinator.resolveCommand`, `RunCoordinator.cancel`, and `RunStatusView`.

- [ ] **Step 1: Write failing lifecycle tests with a fake provider**

```ts
it("REQ-SAF-002: creates a checkpoint before the first provider turn", async () => {
  const run = await coordinator.start(input);
  await waitFor(() => coordinator.get(run.runId).status !== "running");
  expect(checkpointStore.calls[0]).toEqual(expect.objectContaining({ label: "theaihatch agent run checkpoint" }));
  expect(provider.calls).toBeGreaterThan(0);
});

it("REQ-REV-003: status stays waiting_for_review until a complete decision set arrives", async () => {
  const run = await coordinator.start({ ...input, reviewMode: true });
  await waitFor(() => coordinator.get(run.runId).pending?.kind === "review");
  expect(coordinator.get(run.runId).status).toBe("waiting_for_review");
});
```

- [ ] **Step 2: Run the coordinator test and verify failure**

Run: `npx vitest run apps/server/test/run-coordinator.test.ts`

Expected: FAIL because `RunCoordinator` does not exist.

- [ ] **Step 3: Implement background execution with immutable status views**

```ts
export type RunStatus = "running" | "waiting_for_review" | "waiting_for_command" | "completed" | "cancelled" | "failed" | "limit_reached";
export interface RunStatusView { runId: string; checkpointId: string; status: RunStatus; events: AnySesEvent[]; pending: PendingApproval | null; proposals: ProposedAction[]; usage: ProviderUsage; error: string | null; }
export class RunCoordinator {
  start(input: StartRunInput): Promise<{ runId: string; checkpointId: string }>;
  get(runId: string): RunStatusView;
  resolveReview(runId: string, decisions: readonly StoredReviewDecisionInput[]): Promise<RunStatusView>;
  resolveCommand(runId: string, input: { approved: boolean; command: string; cwd: string }): Promise<RunStatusView>;
  cancel(runId: string): void;
}
```

Start the runtime in a detached promise, append SES events to both `SesWriter` and the in-memory status list, persist messages/usage/status at terminal completion, and always close the writer/repositories. Translate checkpoint failures to a rejected start without constructing an adapter or calling the provider.

- [ ] **Step 4: Run coordinator and regression tests**

Run: `npx vitest run apps/server/test/run-coordinator.test.ts packages/agent/test/runtime.test.ts packages/safety/test/safety.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit run coordination**

```bash
git add apps/server/src/agent/run-coordinator.ts apps/server/src/routes/agent.ts apps/server/src/index.ts apps/server/test/run-coordinator.test.ts
git commit -m "feat(agent): coordinate asynchronous safe runs"
```

### Task 5: Expose run, review, approval, and recovery endpoints

**Files:**
- Modify: `apps/server/src/routes/agent.ts`
- Create: `apps/server/test/agent-routes.test.ts`

**Interfaces:**
- Consumes: `RunCoordinator` and `zod` request schemas.
- Produces: `POST /api/agent/runs`, `GET /api/agent/runs/:runId`, `POST /api/agent/runs/:runId/review`, `POST /api/agent/runs/:runId/command-approval`, and `POST /api/agent/runs/:runId/revert`.

- [ ] **Step 1: Write failing route contract tests**

```ts
const started = await app.inject({ method: "POST", url: "/api/agent/runs", payload: { ...runInput, reviewMode: true, dryRun: false } });
expect(started.statusCode).toBe(202);
const state = await app.inject({ method: "GET", url: `/api/agent/runs/${started.json().runId}` });
expect(state.json()).toMatchObject({ status: expect.any(String), pending: null });
```

- [ ] **Step 2: Run the route test and verify failure**

Run: `npx vitest run apps/server/test/agent-routes.test.ts`

Expected: FAIL with a 404 because `/api/agent/runs` is not registered.

- [ ] **Step 3: Add strict schemas and endpoint handlers**

Use `z.enum(["openai", "anthropic", "gemini", "openai-compatible"])`, `z.boolean().default(false)` for `reviewMode`/`dryRun`, exact review decision schemas, and `z.string().uuid()` run parameters. Return 202 for a started run, 409 for stale/mismatched decisions, 404 for unknown runs, and 400 for validation or checkpoint failures. Keep `/api/agent/run` as a temporary adapter that starts then polls to terminal completion so current callers do not break during this Phase.

- [ ] **Step 4: Run focused endpoint tests**

Run: `npx vitest run apps/server/test/agent-routes.test.ts apps/server/test/run-coordinator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit route contracts**

```bash
git add apps/server/src/routes/agent.ts apps/server/test/agent-routes.test.ts
git commit -m "feat(server): expose safe agent run controls"
```

### Task 6: Apply the same policy to inbound MCP mutations

**Files:**
- Modify: `apps/server/src/mcp/inbound-controller.ts`
- Modify: `apps/server/src/mcp/inbound-policy.ts`
- Create: `apps/server/test/mcp-safety.test.ts`

**Interfaces:**
- Consumes: `createGuardedWorkspaceTools`, `ApprovalBroker`, `SafetyAuditRepository`, and the existing `McpController` lease.
- Produces: inbound operation IDs, pending approval visibility, and policy-equivalent edit/command results.

- [ ] **Step 1: Write failing MCP parity tests**

```ts
it("REQ-MPS-006: external dry-run edit leaves the workspace unchanged", async () => {
  const response = await callMcp("edit_file", { path: "a.ts", content: "after" }, { dryRun: true });
  expect(response.error).toBeUndefined();
  expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("before");
});

it("REQ-MPS-006: external destructive command waits for the local approval broker", async () => {
  const operationId = "mcp-op-1";
  const pending = callMcp("run_command", { command: "rm file.txt" });
  await waitFor(() => broker.pending(operationId)?.kind === "command");
  broker.resolveCommand(operationId, { approved: false, command: "rm file.txt", cwd: root });
  await expect(pending).resolves.toMatchObject({ error: expect.anything() });
});
```

- [ ] **Step 2: Run MCP parity tests and verify failure**

Run: `npx vitest run apps/server/test/mcp-safety.test.ts`

Expected: FAIL because inbound MCP directly invokes `createWorkspaceTools`.

- [ ] **Step 3: Route MCP handlers through guarded tools**

Create an operation ID per inbound mutation. Use `createGuardedWorkspaceTools` to invoke `edit_file` and `run_command`, emit generated SES events through the workspace registry, and retain the existing bearer, loopback, input-schema, and control-lease checks. Expose only the pending operation metadata to the local browser; do not expose MCP tokens or tool credentials.

- [ ] **Step 4: Run MCP and existing server tests**

Run: `npx vitest run apps/server/test/mcp-safety.test.ts packages/mcp-server/test/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit MCP policy parity**

```bash
git add apps/server/src/mcp apps/server/test/mcp-safety.test.ts
git commit -m "feat(mcp): apply safety gates to inbound mutations"
```

### Task 7: Add per-run controls and polling review UI

**Files:**
- Modify: `apps/web/src/features/agent/RunPanel.tsx`
- Modify: `apps/web/src/features/review/ReviewPanel.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/e2e/workspace-terminal.spec.ts`

**Interfaces:**
- Consumes: `RunStatusView` JSON with `pending`, `proposals`, `events`, and `usage`.
- Produces: `RunPanel` callbacks with `{ prompt, reviewMode, dryRun }` and complete review/command decision submissions.

- [ ] **Step 1: Write failing browser assertions**

```ts
await page.getByLabel("Review each change").check();
await page.getByLabel("Dry run").check();
await page.getByRole("button", { name: "Run" }).click();
await expect(page.getByText("Dry-run proposals")).toBeVisible();
await expect(page.getByRole("button", { name: "Accept all" })).toBeVisible();
```

- [ ] **Step 2: Run the focused browser test and verify failure**

Run: `npx playwright test apps/web/e2e/workspace-terminal.spec.ts --grep "review mode"`

Expected: FAIL because neither checkbox nor review controls exist.

- [ ] **Step 3: Implement controls, polling, and decision submission**

Extend `RunPanelProps` so `onRun` receives `{ prompt, reviewMode, dryRun }`; add two accessible checkboxes. In `App.tsx`, start through `/api/agent/runs`, poll every 500ms until a terminal status, update workspace events/usage from the status view, and stop polling on unmount or terminal completion. Extend `ReviewPanel` with feedback text, decision state, and an `Accept all` control that submits every hunk. Add a command-approval card showing the exact command and cwd. Render dry-run proposals separately from terminal output and use `onSeek(eventSeq)` for hunk navigation.

- [ ] **Step 4: Run the focused browser test**

Run: `npx playwright test apps/web/e2e/workspace-terminal.spec.ts --grep "review mode"`

Expected: PASS.

- [ ] **Step 5: Commit the Phase 5 UI**

```bash
git add apps/web/src apps/web/e2e/workspace-terminal.spec.ts
git commit -m "feat(web): add safe run review controls"
```

### Task 8: Verify full Phase 5 behavior and update documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/plan.md`
- Modify: `docs/superpowers/specs/2026-09-17-phase-5-safety-review-design.md` only if verification reveals a design inconsistency.

**Interfaces:**
- Consumes: all completed Phase 5 boundaries.
- Produces: reproducible safety/review demo instructions and a verified requirement-to-test mapping.

- [ ] **Step 1: Add a requirement matrix to the relevant test names**

Ensure test descriptions explicitly include `REQ-SAF-001` through `REQ-SAF-007`, `REQ-REV-001` through `REQ-REV-006`, and `REQ-MPS-006`; do not add a separate untested claim in documentation.

- [ ] **Step 2: Document the exact local demo**

Add this workflow to `README.md`: open a Git workspace, save a provider key through the UI, enable **Review each change** or **Dry run**, start a run, resolve the pending review/command card, then inspect replayable events and the checkpoint ID. State that dry-run never writes files or starts commands.

- [ ] **Step 3: Run all required verification commands**

Run:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Expected: all commands exit 0; tests include the new Phase 5 requirement coverage.

- [ ] **Step 4: Review the final diff for secret and scope safety**

Run:

```bash
git diff --check
git diff --cached -- . ':!package-lock.json'
```

Expected: no whitespace errors, no keys/tokens, no unrelated release/packaging changes.

- [ ] **Step 5: Commit Phase 5 verification and documentation**

```bash
git add README.md docs/plan.md apps packages
git commit -m "feat(safety): complete review and approval workflow"
```

## Plan self-review

- Spec coverage: Tasks 1–3 cover REQ-SAF-001, REQ-SAF-004 through REQ-SAF-007, REQ-REV-002 through REQ-REV-004, and REQ-REV-006. Tasks 4–5 cover REQ-SAF-002, REQ-SAF-003, and run lifecycle. Task 6 covers REQ-MPS-006. Task 7 covers REQ-REV-001 and REQ-REV-005. Task 8 verifies every required REQ ID.
- Placeholder scan: no deferred implementation markers or unspecified test actions remain.
- Type consistency: `ApprovalBroker` is the sole pending-approval source; `RunCoordinator` exposes `RunStatusView`; guarded tools consume that broker and review repository; routes and UI consume only `RunStatusView` JSON.
