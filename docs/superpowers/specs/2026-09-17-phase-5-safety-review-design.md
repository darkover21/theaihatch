# Phase 5 safety and review design

## Scope

- Complete REQ-SAF-001 through REQ-SAF-007, REQ-REV-001 through REQ-REV-006, and REQ-MPS-006.
- Preserve default agent execution: review and dry-run are explicit per-run options.
- Use the existing local Fastify server, SQLite databases, SES writer, workspace tools, safety package, review package, and keychain.
- Do not add a WebSocket transport, hosted service, or OS sandbox.

## Run coordination

- Add an in-process `RunCoordinator` in the server.
- A coordinator record owns one run ID, workspace record, checkpoint, SES writer, `AgentRuntime`, safety policy, `ReviewGate`, status, usage, emitted events, and pending approvals.
- `POST /api/agent/runs` validates `{ workspaceId, prompt, provider, model, reviewMode, dryRun }`, creates a checkpoint, persists the running conversation/run, starts background execution, and returns `{ runId, checkpointId }`.
- `GET /api/agent/runs/:runId` returns the current status, appended SES events, usage, errors, pending review, pending command approval, and dry-run proposals.
- `POST /api/agent/runs/:runId/review` accepts all decisions for the active review snapshot. It rejects stale hunk fingerprints, persists decisions/feedback, applies accepted changes only when not dry-run, then resolves the gate.
- `POST /api/agent/runs/:runId/command-approval` accepts `{ approved, command, cwd }`. It only resolves a matching pending destructive command; denial produces a denied tool result and no child process.
- The existing synchronous run route becomes a compatibility wrapper or is removed only after the web app uses the coordinator route.

## Tool safety layer

- Wrap every agent workspace tool before it reaches `AgentRuntime`.
- Resolve every file path through the canonical workspace path policy before reading or mutating.
- Resolve each requested shell working directory through the shell policy; omit the directory only to use the workspace root.
- Classify every command before dispatch. A destructive command pauses on the exact command and canonical working directory.
- In dry-run, file writes and shell commands do not mutate or spawn. Record a proposed action and a normal tool-result event describing the suppression.
- In review mode, a mutating file proposal is compared to its stable pre-change base and turned into frozen file/hunk snapshots. The runtime pauses before its next provider turn until every hunk is resolved.
- Review feedback is delivered by the existing `ReviewGate` exactly once in the next provider message.

## MCP parity

- Replace direct inbound MCP workspace-tool calls with the same safety tool layer and approval broker used by coordinated agent runs.
- Assign inbound calls a run/operation ID for audit records and pending approvals.
- Do not execute an external destructive command before local approval.
- Do not mutate files or spawn processes for an external dry-run action.
- Preserve loopback authentication and mutation-control lease behavior.

## Persistence

- Extend the existing SQLite storage with review snapshots, hunks, decisions, feedback, checkpoint references, and safety audit records keyed by run ID.
- Store immutable before/after content or binary metadata in each review snapshot so history does not depend on current workspace bytes.
- Store hunk IDs/fingerprints, path, line range, linked SES sequence, decision, actor, timestamp, and optional feedback.
- Store audit details as structured redacted JSON. Reject fields and values matching configured provider-secret names or values before persistence.
- Record checkpoint creation, checkpoint recovery/revert, path denial, command approval/denial, and dry-run suppression.

## Browser flow

- Add per-run review and dry-run controls to the agent run panel.
- After starting a run, poll the run status endpoint until terminal state.
- Render pending review hunks through `ReviewPanel`; submit all decisions together so the agent cannot resume with unresolved hunks.
- Render pending command approval with the exact command and canonical working directory.
- Render dry-run proposals without presenting them as completed workspace edits.
- Make a review-hunk selection seek the playback engine to its linked SES event when available.

## Failure handling

- Checkpoint failures prevent provider execution and are returned as a run-start error.
- Policy failures become redacted denied tool results, SES errors, and audit records; they never start a mutation or child process.
- A stale review submission remains pending and returns a conflict response without resuming the agent.
- A cancelled run resolves pending waiters, closes the SES step as cancelled, and persists terminal status.
- Coordinator records remain readable after terminal completion; active records are not evicted while a browser can poll them.

## Verification

- Unit tests cover path/shell enforcement, destructive command matching, dry-run suppression, snapshot/hunk persistence, stale review decisions, and audit redaction.
- Server integration tests cover asynchronous start/status, checkpoint-before-provider ordering, command denial, review pause/continuation, feedback-once delivery, frozen history after external changes, revert recovery checkpoint, and inbound MCP policy parity.
- Browser tests cover per-run options, pending approval display, hunk actions, and dry-run proposal rendering.
- Run `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` before implementation completion.
