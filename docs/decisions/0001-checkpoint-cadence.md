# ADR 0001 — Checkpoint cadence

## Context
Seek cost must remain bounded while checkpoints duplicate all touched-file content. Event byte size and step length vary, and the policy must be deterministic before serialization.

## Decision
Emit a cadence checkpoint after every 500 non-checkpoint events, plus a final checkpoint when a session closes. The fixed event count is simple to index and caps the number of events replayed after restoration.

## Consequences
Large individual edits can make checkpoints uneven in bytes, and short sessions may have only their final checkpoint. Storage grows with the number and cumulative size of touched files.

