# Session stream

## Purpose
Define the Session Event Stream (SES), the single source for live playback and replay. Persist ordered editor-level events and deterministic keyframes.

## Requirements

### REQ-SES-001 — Validate the event envelope
Every event shall conform to the architecture SES union and carry a contiguous `seq`, nondecreasing `t`, supported `type`, and type-specific `payload`.

**Acceptance**
- Given a valid next event, when it is appended, then it is assigned the next integer `seq` and persisted with its millisecond session-relative timestamp.
- Given a malformed payload, sequence gap, or timestamp regression, when append is attempted, then append fails without changing the stream.

### REQ-SES-002 — Persist append-only JSONL
The writer shall append one UTF-8 JSON event per line to `sessions/<session-id>/events.jsonl` and shall not mutate committed lines.

**Acceptance**
- Given an active session, when events are appended and the writer is flushed, then reopening the file yields the same events in order.
- Given an existing committed stream, when another event is appended, then bytes preceding the former end of file are unchanged.

### REQ-SES-003 — Read bounded ranges
The reader shall return validated event ranges by inclusive sequence bounds without loading the full stream.

**Acceptance**
- Given a stream containing sequences 0 through 99, when sequences 20 through 29 are requested, then exactly those ten ordered events are returned.
- Given a range beyond the stream head, when it is requested, then only existing events are returned with an explicit head sequence.

### REQ-SES-004 — Buffer producer and consumer independently
The runtime shall write at machine speed to an unbounded logical buffer while playback consumes at its configured human speed.

**Acceptance**
- Given playback is paused, when the producer appends 1,000 events, then no event is dropped and the head advances by 1,000.
- Given the playback cursor trails the head, when either live or recorded events are consumed, then both follow the same read path and state transitions.

### REQ-SES-005 — Emit deterministic checkpoints
The writer shall emit a checkpoint after every 500 non-checkpoint events, containing complete content for every file touched so far.

**Acceptance**
- Given 499 events since the last checkpoint, when one non-checkpoint event is appended, then the next committed event is a checkpoint with all touched-file snapshots.
- Given fewer than 500 non-checkpoint events since the last checkpoint, when another event is appended, then no cadence checkpoint is emitted.

### REQ-SES-006 — Seek from a checkpoint
The reader shall seek by restoring the nearest valid checkpoint at or before the target and replaying subsequent events; it shall never replay from sequence 0 when a preceding checkpoint exists.

**Acceptance**
- Given checkpoints at sequences 100 and 600 and target 750, when seeking, then sequence 600 is restored and sequences 601 through 750 are replayed.
- Given a target before the first checkpoint, when seeking, then the initial empty workspace state is used and events through the target are replayed.

### REQ-SES-007 — Detect and contain corruption
Startup validation shall detect invalid JSON, schema violations, sequence gaps, and truncated final lines; only a truncated final line may be quarantined automatically.

**Acceptance**
- Given a truncated final line, when the session opens, then the line is copied to `recovery.jsonl`, excluded from playback, and the session is marked `recovered`.
- Given corruption before the final line, when the session opens, then playback stops before that line and the session is marked `corrupt` without rewriting `events.jsonl`.

### REQ-SES-008 — Store session metadata
SQLite shall store session identity, workspace path, lifecycle timestamps, status, stream path, head sequence, duration, provider/model references, token totals, cost total, and integrity status.

**Acceptance**
- Given a newly created session, when its first event commits, then a metadata row exists and its head sequence and duration match that event.
- Given an existing session, when metadata is listed, then no JSONL scan is required to show its summary.

### REQ-SES-009 — Use a stable on-disk layout
Session data shall use `<data-dir>/sessions/<session-id>/events.jsonl`, `index.sqlite`, and optional `recovery.jsonl`, with SQLite at `<data-dir>/sessions.sqlite`.

**Acceptance**
- Given a valid session identifier, when a session is created, then all artifacts resolve beneath its session directory and metadata points to relative paths.
- Given an identifier containing traversal characters, when creation is attempted, then it is rejected before filesystem access.

## Dependencies
- None

## Out of scope
- Cloud synchronization
- Cross-session event ordering
