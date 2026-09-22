# ADR-0007: Incremental checkpoints with periodic full anchors

## Decision

A cadence checkpoint records only the files touched since the previous checkpoint, under the new reason `"delta"`. A full checkpoint, which restates every file the session has touched, is written only when the deltas accumulated since the last full one have cost as many bytes as that full one did. `"cadence"`, `"final"` and `"hydration"` continue to mean full state.

`SesReader.getCheckpointAtOrBefore` returns only full checkpoints, since a delta cannot seed a restore on its own. Seeking therefore restores from the nearest full checkpoint and replays forward, applying any intervening deltas in order. `applyFileEvent` and `restoreCheckpointFiles` merge a checkpoint's files into the projection rather than replacing it, which is equivalent to replacement for a full checkpoint applied to an empty projection.

## Rationale

`checkpointFiles` serialised every path in `touched`, and `touched` only ever grew. With a checkpoint every 500 events, a stream's size grew with the square of its event count. A real session on this machine reached 1.0 GB, of which **1,111 MB across 84 checkpoint events** — 97% of the file — for 28 MB of actual edits. Four such sessions accounted for 3.5 GB.

Paying for a full checkpoint only once the deltas have cost as much bounds total checkpoint bytes to roughly twice the delta volume, which is linear in session length rather than quadratic. Measured on a synthetic 12,024-event session touching 4,000 files: 16.7 MB of checkpoints against 80.8 MB under the previous behaviour, a 4.8x reduction that widens as a session grows.

REQ-SES-005 fixes the checkpoint cadence but does not require every checkpoint to be a full snapshot, so this remains conformant.

## Consequences

Streams written before this change contain only full checkpoints, under the reasons that still mean full state, so they restore exactly as before. No migration is required and none is performed.

Restoring now costs one full checkpoint plus the deltas after it, rather than one checkpoint. That is a bounded amount of extra replay in exchange for removing the quadratic growth.

Existing oversized sessions remain on disk. `npm run sessions:prune` reports them and deletes only sessions that recorded nothing; sessions holding real events are never removed automatically, because they are the user's recordings.
