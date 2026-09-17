# Step grouping

## Purpose
Map raw SES events into labeled units that communicate intent. Provide boundaries for navigation, checkpoints, and human approval.

## Requirements

### REQ-STP-001 — Persist explicit boundaries
Every agent-produced meaningful unit shall emit one `step_begin` and one matching `step_end` with a stable step identifier.

**Acceptance**
- Given an agent starts a unit, when its first action is emitted, then a `step_begin` precedes it.
- Given the unit succeeds, fails, or is cancelled, when it closes, then exactly one matching `step_end` records the outcome.

### REQ-STP-002 — Generate concise labels
Each step shall have an imperative label derived from its tool intent and primary path, limited to 100 characters.

**Acceptance**
- Given edits that add an auth guard to `router.ts`, when grouped, then the step exposes a nonempty label naming the action and `router.ts`.
- Given a generated label over 100 characters, when stored, then it is deterministically shortened to at most 100 characters.

### REQ-STP-003 — Group raw events deterministically
Events between matching boundaries shall belong to that step; unbounded fixture events shall group by contiguous file operation or terminal command.

**Acceptance**
- Given explicit boundaries, when the index is built, then every enclosed event maps to the boundary step identifier.
- Given a fixture without boundaries, when indexed twice, then both indexes produce identical inferred groups.

### REQ-STP-004 — Present a step list
The UI shall list steps in sequence with label, status, affected files, and start/end positions.

**Acceptance**
- Given an indexed session, when the step panel opens, then steps appear in sequence order with their affected files.
- Given playback crosses a boundary, when the panel renders, then the current step is highlighted.

### REQ-STP-005 — Navigate by group
Next-step and previous-step actions shall navigate group boundaries rather than individual events.

**Acceptance**
- Given a step containing 30 events, when next-step is selected inside it, then the cursor advances to that step's end.
- Given the cursor is at a step start, when previous-step is selected, then the cursor lands before the preceding step.

## Dependencies
- session-stream

## Out of scope
- Semantic summarization after a session completes
- User-defined nested step hierarchies

