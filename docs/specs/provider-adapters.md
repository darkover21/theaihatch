# Provider adapters

## Purpose
Normalize model streaming, tool calls, usage, and errors behind one provider-neutral interface. Keep provider concerns out of the agent runtime.

## Requirements

### REQ-PRV-001 — Expose one provider interface
All adapters shall implement model listing, connection testing, streamed generation, cancellation, normalized tool calls, normalized usage, and normalized errors.

**Acceptance**
- Given any configured adapter, when the runtime starts a turn, then it receives the same normalized event union.
- Given a runtime cancellation signal, when passed to any adapter, then its in-flight SDK or HTTP request is aborted.

### REQ-PRV-002 — Support Anthropic
The Anthropic adapter shall use `@anthropic-ai/sdk` for streaming messages and tool use.

**Acceptance**
- Given valid Anthropic credentials and model, when a streamed tool request is made, then deltas and the completed tool call are normalized in order.
- Given an Anthropic API error, when returned, then its retryability and user-safe message are normalized.

### REQ-PRV-003 — Support OpenAI
The OpenAI adapter shall use `openai` for streaming responses and tool calls.

**Acceptance**
- Given valid OpenAI credentials and model, when a streamed response is requested, then text, tool calls, completion, and usage are normalized.
- Given multiple tool calls in one response, when streamed, then their identifiers and arguments remain distinct.

### REQ-PRV-004 — Support Google Gemini
The Gemini adapter shall use `@google/genai` for streaming content and function calls.

**Acceptance**
- Given valid Gemini credentials and model, when a function call is streamed, then it becomes one normalized tool call.
- Given Gemini safety blocking, when returned, then the normalized completion reason identifies it as blocked.

### REQ-PRV-005 — Support OpenAI-compatible endpoints
One adapter shall support Ollama, LM Studio, OpenRouter, vLLM, and other OpenAI-compatible APIs through configurable base URL, key, headers, and model identifier.

**Acceptance**
- Given a local endpoint requiring no key, when its connection test succeeds, then it can stream through the normalized interface.
- Given a configured base URL and custom headers, when a request is sent, then only that adapter instance receives those values.

### REQ-PRV-006 — Select provider and model
The UI shall list configured providers and their available or manually configured models, and persist the selection per workspace.

**Acceptance**
- Given two configured providers, when a model is selected, then the next run uses that adapter and model.
- Given a model-list endpoint is unavailable, when a manual model identifier is saved, then it remains selectable.

### REQ-PRV-007 — Store keys in the OS keychain
Provider secrets shall be stored and retrieved only through the operating-system keychain, never config files, SQLite, JSONL, logs, or SES payloads.

**Acceptance**
- Given a key is saved, when project and data directories are searched, then the key bytes are absent.
- Given keychain retrieval fails, when a connection is attempted, then the UI requests credentials without logging the secret.

### REQ-PRV-008 — Test connections
Each provider configuration shall offer a bounded connection test that reports authentication, reachability, and model availability separately.

**Acceptance**
- Given valid credentials and model, when tested, then all checks pass without starting an agent run.
- Given a reachable endpoint with an invalid key, when tested, then reachability passes and authentication fails.

## Dependencies
- None

## Out of scope
- Provider-specific agent logic
- Bundled API keys or hosted proxying

