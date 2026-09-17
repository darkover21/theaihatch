# Agent runtime

## Purpose
Run the coding-agent loop independently of any model provider. Convert streamed model output and approved tool execution into durable SES events.

## Requirements

### REQ-AGT-001 — Execute the tool-calling loop
The runtime shall alternate provider turns and tool results until completion, cancellation, approval wait, or configured limit.

**Acceptance**
- Given a provider returns one tool call, when it is allowed and executes, then its result is supplied to the next provider turn.
- Given the provider returns a final response, when streaming ends, then the run closes without another provider call.

### REQ-AGT-002 — Stream into SES
Text deltas, thoughts exposed by the provider, tool calls, tool results, workspace actions, and errors shall be emitted incrementally as typed SES events.

**Acceptance**
- Given streaming output, when deltas arrive, then corresponding events become readable before the provider turn completes.
- Given a tool edits a file, when it executes, then granular edit and save events describe the change rather than only a whole-file result.

### REQ-AGT-003 — Cancel mid-run
The user shall cancel an active model stream or tool execution, propagating an abort signal and closing the current step.

**Acceptance**
- Given an active provider stream, when cancel is selected, then the stream is aborted and the run becomes cancelled.
- Given an active command, when cancel is selected, then the process is terminated and its step ends with cancelled outcome.

### REQ-AGT-004 — Retry transient failures
The runtime shall retry provider rate-limit and transient server failures with capped exponential backoff and jitter, but shall not retry authentication or invalid-request failures.

**Acceptance**
- Given two retryable failures followed by success, when a turn runs, then it completes after two recorded backoff attempts.
- Given an authentication failure, when a turn runs, then it fails after one attempt and exposes the error.

### REQ-AGT-005 — Account for usage and cost
The runtime shall record input, output, cached, and reasoning token counts when supplied, plus estimated run cost using a versioned model-price table.

**Acceptance**
- Given provider usage fields, when a turn closes, then the session and run totals equal the sum of normalized fields.
- Given unknown pricing, when usage is recorded, then tokens remain exact and cost is displayed as unavailable rather than zero.

### REQ-AGT-006 — Persist conversations
Messages, normalized tool calls, tool results, and run status shall persist in SQLite and be reloadable for continuation.

**Acceptance**
- Given a completed turn, when the server restarts, then its conversation can be loaded in original order.
- Given a cancelled turn, when loaded, then its cancellation status and partial messages are retained.

### REQ-AGT-007 — Compose the system prompt
The runtime shall deterministically compose the product safety rules, workspace context, enabled tool contracts, and user-configured instructions in documented precedence order.

**Acceptance**
- Given identical inputs, when prompts are composed twice, then their bytes are identical.
- Given conflicting user instructions and platform safety rules, when composed, then platform safety rules retain precedence.

### REQ-AGT-008 — Enforce run limits
The runtime shall stop at configurable maximum turns, tool calls, or token budget and emit the limit reached.

**Acceptance**
- Given a five-turn limit, when a sixth turn would begin, then it is not sent and the run ends with `limit_reached`.
- Given a token budget is reached, when another turn is requested, then the request is blocked and current accounting is preserved.

## Dependencies
- provider-adapters
- session-stream
- step-grouping

## Out of scope
- Model training
- Autonomous background runs without a user-started session
