# ADR 0002 — Step grouping heuristic

## Context
Agent runs can declare meaningful intent, while hand-written fixtures and imported streams may contain only raw events. Step navigation needs stable groups in both cases.

## Decision
Agent runs emit explicit matching `step_begin` and `step_end` boundaries. When boundaries are absent, group each contiguous file operation and each terminal command; label the group from operation kind and primary path or command.

## Consequences
Explicit groups preserve agent intent. Inferred groups are deterministic but less semantic, and malformed overlapping boundaries fail validation instead of being guessed.

