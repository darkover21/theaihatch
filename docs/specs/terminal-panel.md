# Terminal panel

## Purpose
Show agent commands as observable work, including human-speed command entry and live output. Surface completion status without hiding raw terminal data.

## Requirements

### REQ-TRM-001 — Render terminal events
xterm.js shall render `terminal_command` and `terminal_output` events in sequence with preserved stdout/stderr channel and byte order.

**Acceptance**
- Given interleaved stdout and stderr events, when played, then visible chunks retain SES order and channel styling.
- Given terminal history, when seeking, then terminal content reconstructs to the target sequence.

### REQ-TRM-002 — Animate command entry
Command text shall appear character by character before execution, never as an instantaneous paste unless instant mode is active.

**Acceptance**
- Given a command event at normal speed, when played, then the prompt displays its characters according to the typing scheduler before output starts.
- Given instant mode, when the same event plays, then the full command appears atomically before output.

### REQ-TRM-003 — Stream output
Process output shall be chunked into SES events as received and shown without waiting for process completion.

**Acceptance**
- Given a command that emits two chunks one second apart, when run, then the first chunk is visible before the second is produced.
- Given binary-invalid UTF-8 bytes, when captured, then replacement decoding is deterministic and playback remains valid.

### REQ-TRM-004 — Surface process outcome
Each command shall expose running, exited, cancelled, or failed state and its exit code or terminating signal.

**Acceptance**
- Given a process exits with code 2, when its final event plays, then code 2 is visible and the command is marked failed.
- Given cancellation, when the process terminates, then the terminal shows cancelled status and no successful exit code.

### REQ-TRM-005 — Manage the panel
The terminal panel shall be resizable, collapsible, and automatically revealed when a command begins.

**Acceptance**
- Given a collapsed terminal, when a command event starts, then the panel opens and focuses its active terminal view.
- Given a resized panel, when it is collapsed and reopened, then its previous height is restored.

## Dependencies
- session-stream
- human-typing-simulation

## Out of scope
- General-purpose interactive terminal multiplexing
- Shell sessions outside the workspace
