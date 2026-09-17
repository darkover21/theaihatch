# Human typing simulation

## Purpose
Render edit and navigation events with believable human timing and motion. Keep large changes watchable without losing event fidelity.

## Requirements

### REQ-TYP-001 — Schedule characters with jitter
Inserted text shall render per character at a configurable base WPM with seeded bounded jitter.

**Acceptance**
- Given fixed text, WPM, and seed, when rendered twice, then both runs produce identical character timestamps.
- Given a higher WPM, when the same text renders, then its total base typing duration is lower.

### REQ-TYP-002 — Add syntax-aware pauses
The scheduler shall add configurable pauses at line endings, after `{`, and before expressions classified as dense.

**Acceptance**
- Given text containing a newline and `{`, when timing is generated, then both positions include their configured pause classes.
- Given a dense expression, when timing is generated, then a pre-expression pause occurs before its first character.

### REQ-TYP-003 — Accelerate long blocks
An edit above 2,000 characters or 80 lines shall default to instant mode, rendered as one atomic delta with a visible change flash.

**Acceptance**
- Given a 400-line insertion, when it plays with defaults, then it completes as one atomic delta rather than 400 lines of typing.
- Given a below-threshold insertion, when it plays with defaults, then characters appear individually.

### REQ-TYP-004 — Allow explicit instant mode
The user shall toggle instant mode globally without altering the SES.

**Acceptance**
- Given instant mode is enabled, when an insertion event plays, then its full delta appears atomically.
- Given instant mode is disabled, when an eligible short insertion plays, then per-character scheduling resumes.

### REQ-TYP-005 — Ease cursor motion
Cursor movement shall interpolate screen position with a capped ease-in-out duration and land at the exact SES position.

**Acceptance**
- Given two visible positions, when `cursor_move` plays, then intermediate frames follow the configured easing curve and finish at the target.
- Given a target outside the viewport, when movement begins, then scrolling and cursor motion complete without an intermediate invalid position.

### REQ-TYP-006 — Follow scrolling without jitter
Playback shall keep the active cursor within a configurable vertical safe zone and use smooth scroll except during seek or instant mode.

**Acceptance**
- Given typing crosses the safe-zone edge, when the next line appears, then the viewport scrolls to restore the cursor to the safe zone.
- Given a seek restoration, when the target is projected, then the viewport jumps directly to the recorded scroll position.

## Dependencies
- session-stream

## Out of scope
- Biometric imitation of a specific person
- Recording physical keyboard input timing
