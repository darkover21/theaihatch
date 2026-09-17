# Playback engine

## Purpose
Turn SES events into one controllable presentation path for both live and recorded sessions. Maintain deterministic transport state and projection state.

## Requirements

### REQ-PLY-001 — Implement the playback state machine
Playback shall use `loading`, `paused`, `playing`, `seeking`, `at-live-head`, `ended`, and `error` states with explicit transitions.

**Acceptance**
- Given a loaded session at a non-head cursor, when play is pressed, then state becomes `playing` and events advance.
- Given any non-error state, when an unrecoverable read error occurs, then state becomes `error` and playback stops.

### REQ-PLY-002 — Control playback and speed
The transport shall play, pause, and select speeds from 0.25× through 32× while preserving event order.

**Acceptance**
- Given paused playback, when play is selected at 2×, then simulated delays are half their 1× duration.
- Given playing playback, when pause is selected, then the cursor and projected workspace stop after the current atomic event.

### REQ-PLY-003 — Step by event
The transport shall move one SES event forward or backward while paused.

**Acceptance**
- Given cursor 20, when event-forward is selected, then event 21 is applied and the cursor becomes 21.
- Given cursor 20, when event-back is selected, then state is reconstructed at sequence 19 and remains paused.

### REQ-PLY-004 — Step by group
The transport shall move to the next `step_begin` or preceding `step_begin` boundary while paused.

**Acceptance**
- Given the cursor is inside a step, when step-forward is selected, then playback lands at the end of that step.
- Given the cursor is inside a step, when step-back is selected, then playback lands immediately before that step begins.

### REQ-PLY-005 — Seek by timeline and file
The engine shall seek to a scrubber target sequence or the first matching file event selected from a file-event index.

**Acceptance**
- Given a timeline target, when the scrubber is released, then the nearest checkpoint is restored and state matches the target sequence.
- Given a file and selected occurrence, when file seek is invoked, then playback lands on that occurrence and opens the file.

### REQ-PLY-006 — Represent live as proximity to head
Live shall be ordinary playback whose cursor is at or near the stream head, with a behind-live count and jump-to-live action.

**Acceptance**
- Given the cursor trails the head by three completed steps, when rendered, then the UI shows `3 steps behind`.
- Given any behind-live cursor, when jump-to-live is selected, then buffered events are applied at catch-up speed and state becomes `at-live-head`.

### REQ-PLY-007 — Follow a growing stream
At the live head, the engine shall wait for new appended events and apply them through the same scheduler used for replay.

**Acceptance**
- Given state `at-live-head`, when a valid event is appended, then it is scheduled and projected without reloading the session.
- Given an ended recorded stream, when play reaches its head, then state becomes `ended` rather than waiting for events.

## Dependencies
- session-stream
- human-typing-simulation
- step-grouping

## Out of scope
- Editing playback timing data in the source stream
- Concurrent playback cursors in one view

