# Review and approval

## Purpose
Let the user inspect and control agent changes before work proceeds. Feed rejection context back into the same agent loop.

## Requirements

### REQ-REV-001 — Show a diff review panel
The UI shall display each proposed file change as a base-to-working diff grouped by file and hunk.

**Acceptance**
- Given agent changes to two files, when review opens, then both files and all changed hunks are visible.
- Given a binary file change, when review opens, then it is identified as binary with before/after metadata instead of a text hunk.

### REQ-REV-002 — Accept or reject per hunk
The user shall accept or reject each text hunk independently, with decisions applied to the working tree and recorded.

**Acceptance**
- Given two independent hunks, when one is accepted and one rejected, then the resulting file contains only the accepted change.
- Given an overlapping or stale hunk, when a decision is applied, then it fails safely and requests refresh without corrupting the file.

### REQ-REV-003 — Gate agent continuation
At configured review boundaries, the agent loop shall pause after its step and continue only after the review is resolved.

**Acceptance**
- Given a gated step with unresolved hunks, when the agent requests another turn, then no provider request is sent.
- Given all hunks are resolved, when continue is selected, then the next provider turn may start with the decisions included.

### REQ-REV-004 — Reject with feedback
The user shall attach feedback to any rejected hunk or the whole review, and that feedback shall become a structured tool result for the next agent turn.

**Acceptance**
- Given a rejected hunk with feedback, when the loop continues, then the next provider input contains its path, hunk, decision, and feedback.
- Given whole-review feedback, when submitted, then it is persisted with the run and delivered once to the next turn.

### REQ-REV-005 — Review from playback context
Selecting a diff or hunk shall seek to the SES event that introduced it and focus the matching editor range.

**Acceptance**
- Given a hunk linked to an edit event, when selected, then playback pauses at that event and highlights its range.
- Given a deleted file, when its review entry is selected, then the last checkpoint containing it is shown in a read-only diff.

### REQ-REV-006 — Preserve review history
Review decisions, feedback, hunk fingerprints, and acting local user shall persist with the run.

**Acceptance**
- Given a completed review, when the app restarts, then its decisions and feedback remain visible.
- Given file content changes after review, when history opens, then it displays the reviewed snapshot rather than recomputing against current bytes.

## Dependencies
- session-stream
- editor-surface
- agent-runtime
- safety-and-checkpoints

## Out of scope
- Multi-user code review
- Hosting-provider pull-request review

