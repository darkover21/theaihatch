# Prompt for Codex — Generate specs and implementation plan

> Paste everything below the line into Codex. Replace `<PROJECT_NAME>` and `<REPO_PATH>` first.

---

## Role

You are a systems architect. Produce specification and planning **files** for a new open-source project. 

Output rules — follow strictly:
- Write files. Do not print commentary, summaries, or restatements of this brief in chat.
- Terse bullets over prose. No marketing language. No "Note that", no "It's worth mentioning".
- Do not propose alternatives to decisions marked **LOCKED**. They are settled.
- Do not invent requirements outside the capability list. If something is genuinely missing, add it to `docs/open-questions.md` as one line — do not spec it.
- Every requirement must be testable. If you cannot write a Given/When/Then for it, it is not a requirement.

Working directory: `<REPO_PATH>`

---

## Product kernel

`<PROJECT_NAME>` is a locally-run, open-source web platform with a VS Code–like interface. It runs an AI coding agent against the user's local project, and **renders the agent's work as a human-speed animation**: the file opens in the sidebar, the cursor moves, code is typed line by line, the file is saved, the next file opens. The user watches as if looking over a senior developer's shoulder, with transport controls — play, pause, speed, step forward/back, seek, jump to live.

The product is not "an AI coding tool with a progress bar." The animation **is** the product. Everything else serves it.

---

## LOCKED decisions

Do not reconsider, do not write ADRs for these, do not list trade-offs.

| Area | Decision |
|---|---|
| Runtime | Local HTTP server + browser UI on `localhost`. Shipped as a single self-contained binary per OS (Windows, macOS, Linux). No Electron, no Tauri, no cloud component. |
| Scope | Live agent **and** replay. The platform runs the agent itself and animates its actions; it can also replay a recorded session. |
| License | Apache-2.0 |
| Editor | Monaco Editor |
| Terminal | xterm.js |
| Server | Node 22 + TypeScript strict + Fastify + `ws` |
| UI | React + Vite + Tailwind |
| Storage | SQLite for session metadata; JSONL files on disk for event streams |
| Keys | Bring-your-own. Never bundled, never committed, stored in the OS keychain. |

---

## Architecture correction — read before specifying anything

Two layers, separate, do not conflate them:

**1. Provider layer (model access).** Adapters that normalize streaming and tool-calling across:
- Anthropic (`@anthropic-ai/sdk`)
- OpenAI (`openai`)
- Google Gemini (`@google/genai`)
- Any OpenAI-compatible endpoint — Ollama, LM Studio, OpenRouter, vLLM — via a single configurable-base-URL adapter

One interface. The agent runtime never knows which provider is behind it.

**2. MCP layer (tools and context).** MCP is *not* a model-routing protocol. It connects an agent to tools, resources and prompts. `<PROJECT_NAME>` uses it in both directions:
- **As MCP client** — connects to user-configured MCP servers over stdio and streamable HTTP, discovers their tools, exposes them to the agent with a per-tool approval policy.
- **As MCP server** — publishes the platform's own tools (open file, edit, save, run command, animate step) so an *external* agent can drive the animation.

---

## Keystone: the Session Event Stream (SES)

This is given, not up for design. Everything — live view, replay, seek, speed control, stepping — reads and writes this one structure. Specify it first; every other capability depends on it.

**SES is an append-only, monotonically-timestamped JSONL log of editor-level events.**

Event types:

```
workspace_open      file_open          file_close         tab_focus
cursor_move         selection_change   scroll
edit_insert         edit_delete        edit_replace
file_create         file_save          file_delete        file_rename
terminal_command    terminal_output
agent_thought       agent_tool_call    agent_tool_result
step_begin          step_end
checkpoint          diff_marker        error
```

Every event carries: `seq` (monotonic integer), `t` (ms since session start), `type`, `payload`. Edits carry a file path, a position, and the text delta — never a whole-file rewrite except in `checkpoint`.

### Rule 1 — speed decoupling (REQUIRED)

The agent runs at machine speed. Playback runs at human speed. They are decoupled by an unbounded buffer.

Consequence, and state it in the spec: **live mode is not a separate mode.** Live mode is playback whose cursor happens to be near the head of the stream. The UI shows a *behind-live* indicator (`3 steps behind`) and a *jump to live* control. This makes live and replay one code path instead of two.

### Rule 2 — keyframes (REQUIRED)

Deterministic seek requires periodic full-file snapshots. `checkpoint` events carry the complete content of every file touched so far. Seeking backwards means: find the nearest preceding checkpoint, restore, replay forward from there. Never replay from `seq` 0.

Specify the checkpoint cadence policy (event count, byte volume, or step boundary — pick one, justify in one line).

---

## Capabilities to specify

One spec file per capability. Numbered requirements, each with acceptance criteria.

| ID | Capability | Must cover |
|---|---|---|
| `session-stream` | SES core | Schema, append, read, seek, keyframes, on-disk layout, integrity/corruption handling, session metadata in SQLite |
| `playback-engine` | Transport | Play/pause; speed 0.25×–32×; step forward/back by **event** and by **step group**; seek by timeline scrubber and by file; jump-to-live; behind-live indicator; playback state machine |
| `human-typing-simulation` | The illusion | Per-character timing with jitter; realistic pause points (end of line, after `{`, before a dense expression); configurable base WPM; **instant mode** for long generated blocks so a 400-line file is not a 20-minute wait; cursor motion easing; scroll-to-follow behaviour |
| `step-grouping` | Meaningful steps | Raw events collapse into human-readable steps ("Add auth guard to `router.ts`"); `step_begin`/`step_end` boundaries; step list panel; "next step" jumps between groups, not events |
| `workspace` | Local project | Open a folder; file tree; git status decoration; watch for external changes; ignore rules (`.gitignore`, `node_modules`) |
| `editor-surface` | VS Code–like UI | Monaco multi-tab editor; activity bar + sidebar explorer; syntax highlighting; minimap; diff gutter; **read-only while playback is running**; theme (dark default) |
| `terminal-panel` | Commands | xterm.js panel; animated command entry (typed, not pasted); streamed output; exit codes surfaced |
| `agent-runtime` | The loop | Tool-calling loop; streaming; cancellation mid-run; retry/backoff; token and cost accounting per run; conversation persistence; system prompt composition |
| `provider-adapters` | Model access | The four adapters above; normalized streaming + tool-call interface; model selection UI; key storage in OS keychain; connection test |
| `mcp-client` | Outbound tools | Server config (stdio + streamable HTTP); tool discovery; tool listing UI; per-tool approval policy (always ask / allow / deny); failure isolation so one bad server does not kill a run |
| `mcp-server` | Inbound control | Publish platform tools outward; transport; auth for non-local callers (or explicitly localhost-only — decide and state it) |
| `safety-and-checkpoints` | Not destroying work | Workspace path allowlist — no writes outside project root; git-backed auto-checkpoint before every agent run; one-click revert to any checkpoint; destructive-command confirmation; shell confined to workspace root; dry-run mode |
| `review-and-approval` | Human in the loop | Diff review panel; per-hunk accept/reject; approval gate before the agent continues; reject-with-feedback back into the agent loop |
| `packaging` | Ship it | Single binary per OS; first-run flow; port selection with fallback; auto-open browser; config file location per OS; update check |
| `open-source-hygiene` | Repo quality | Apache-2.0 LICENSE; README with a GIF of the animation; CONTRIBUTING; CODE_OF_CONDUCT; issue/PR templates; CI matrix across win/mac/linux; semantic-release; no secrets in repo; `SECURITY.md` |

---

## Explicit non-goals

State these in `docs/architecture.md`. They are what makes v1 finishable.

- No remote or multi-user collaboration. Single user, single machine.
- No cloud hosting, no account system, no telemetry.
- No VS Code extension host. It looks like VS Code; it is not VS Code.
- No debugger.
- No language servers beyond what Monaco provides built-in.
- No mobile or tablet layout.
- No model fine-tuning, no embeddings store, no RAG pipeline in v1.
- Not a VS Code extension. Standalone.

---

## Output contract

Write exactly these files. Nothing else.

### `docs/specs/<capability-id>.md` — one per capability

```markdown
# <Capability name>

## Purpose
<2–3 lines. Why this exists.>

## Requirements

### REQ-<CAP>-001 — <short title>
<One-line statement of the requirement.>

**Acceptance**
- Given <state>, when <action>, then <observable outcome>.
- Given <state>, when <action>, then <observable outcome>.

### REQ-<CAP>-002 — ...

## Dependencies
- <other capability ids this needs>

## Out of scope
- <things a reader might assume are here but are not>
```

### `docs/architecture.md`

- Module boundaries and responsibilities
- Data flow diagram in text (agent → SES writer → buffer → playback engine → UI)
- The SES schema as **TypeScript type definitions**, complete, copy-pasteable
- Process/threading model
- Non-goals section

### `docs/plan.md`

Phases. Each phase:

```markdown
## Phase N — <name>

**Goal:** <one line>
**Demo:** <what a human can watch working when this phase lands>
**Requirements covered:** REQ-XXX-001, REQ-XXX-002, ...

### Tasks
- [ ] <task> → `path/to/file.ts`
- [ ] <task> → `path/to/file.ts`

**Exit criteria**
- <testable condition>
```

### `docs/decisions/NNNN-<slug>.md`

ADRs only for genuinely contested choices — checkpoint cadence, step-grouping heuristic, buffer backpressure policy, MCP server auth. Max 8. Format: Context / Decision / Consequences. Three paragraphs maximum each. No ADRs for LOCKED decisions.

### `docs/open-questions.md`

One line per unresolved question. No elaboration.

---

## Phasing guidance — mandatory ordering

Walking skeleton. Something watchable must exist before any LLM is involved.

1. **Phase 1 — SES + playback from a fixture.** Ship the event schema, the JSONL reader/writer, the playback engine, and a Monaco surface that animates a *hand-written fixture session file*. Transport controls work. **No agent, no provider, no API key needed to demo this.** If Phase 1 needs a key, the phasing is wrong.
2. **Phase 2 — Real workspace.** Folder open, file tree, tabs, git status, terminal panel. Record real SES streams from scripted edits.
3. **Phase 3 — Agent runtime + one provider.** Tool loop against a single adapter. Agent actions write SES. The animation now shows real AI work.
4. **Phase 4 — Remaining providers + MCP client/server.**
5. **Phase 5 — Safety, checkpoints, review and approval.**
6. **Phase 6 — Packaging, CI matrix, release, open-source hygiene.**

Each phase must be independently demoable and independently mergeable.

---

## Begin

Write the files. No chat output beyond a final one-line file list.
