# ADR 0003 — Buffer backpressure policy

## Context
The producer runs at machine speed and playback can pause indefinitely. Applying playback pressure to the agent would conflate execution rate with presentation rate; retaining every event only in memory would exhaust RAM.

## Decision
Treat committed JSONL as an unbounded logical buffer and keep only a bounded in-memory window plus byte-offset index. The producer waits only for durable append; slow playback never drops events or throttles for presentation, and disk exhaustion fails the run explicitly.

## Consequences
Long sessions consume disk while memory stays bounded. Catch-up reads older ranges from disk, and storage health must be checked before and during a run.

