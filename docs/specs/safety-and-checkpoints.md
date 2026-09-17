# Safety and checkpoints

## Purpose
Confine agent actions to the selected project and make every run reversible. Require explicit consent for destructive shell behavior and support non-mutating previews.

## Requirements

### REQ-SAF-001 — Enforce the workspace allowlist
All file reads and writes initiated by an agent shall resolve through canonical-path checks and writes shall be limited to the workspace root.

**Acceptance**
- Given a path inside the canonical root, when an allowed write is requested, then it proceeds.
- Given traversal, symlink escape, or absolute path outside the root, when a write is requested, then it is denied and recorded.

### REQ-SAF-002 — Create a Git checkpoint before each run
Before every agent run, the platform shall capture the complete workspace state in a Git-backed checkpoint reference without changing the user's current branch or index.

**Acceptance**
- Given tracked, staged, untracked, and deleted files, when a run begins, then its checkpoint can restore all four states byte-for-byte.
- Given checkpoint creation fails, when a run is requested, then the agent does not start and the failure is shown.

### REQ-SAF-003 — Revert to a checkpoint
The user shall restore any recorded run checkpoint with one confirmed action, after creating a safety checkpoint of the current state.

**Acceptance**
- Given a prior checkpoint, when revert is confirmed, then workspace files and index match that checkpoint.
- Given a revert target and current changes, when revert starts, then a new recovery checkpoint is recorded first.

### REQ-SAF-004 — Confirm destructive commands
Commands classified as destructive shall not execute until the user approves the exact command and working directory.

**Acceptance**
- Given a destructive command, when requested, then execution remains blocked until the prompt is approved.
- Given the prompt is denied, when the agent resumes, then it receives a denied tool result and no process starts.

### REQ-SAF-005 — Confine shell execution
Agent commands shall start with the workspace as working directory and reject any requested working directory that resolves outside it.

**Acceptance**
- Given no working directory, when a command starts, then its process working directory is the workspace root.
- Given an outside working directory, when execution is requested, then it is rejected before process creation.

### REQ-SAF-006 — Support dry-run mode
Dry-run mode shall execute no mutating file tool or shell command and shall produce a reviewable proposed action stream.

**Acceptance**
- Given dry-run mode, when a file edit is approved, then workspace bytes remain unchanged and a proposed diff is emitted.
- Given dry-run mode, when a command is requested, then it is not spawned and is recorded as proposed.

### REQ-SAF-007 — Audit safety decisions
Approvals, denials, path rejections, checkpoint creation, revert, and dry-run suppression shall be recorded with timestamp and run identifier without secrets.

**Acceptance**
- Given a denied destructive command, when the session is reviewed, then the decision and command classification are present.
- Given an environment containing a provider key, when audit records are inspected, then the key value is absent.

## Dependencies
- workspace
- session-stream

## Out of scope
- OS-level sandbox guarantees
- Recovery from hardware or filesystem failure

