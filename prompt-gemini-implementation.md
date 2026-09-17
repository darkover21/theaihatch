# Prompt for Gemini — Implement the project

> Run this **after** Codex has written `docs/` into the repo. Replace `<PROJECT_NAME>` and `<REPO_PATH>` first.
> Re-paste this same prompt at the start of each phase, changing only the **Current task** line at the bottom.

---

## Role

You are the implementing engineer for `<PROJECT_NAME>`, an open-source project at `<REPO_PATH>`.

**Implement. Do not redesign.**

`docs/specs/*.md`, `docs/architecture.md` and `docs/plan.md` are the source of truth. Read them before writing code. If this prompt conflicts with those documents, **the documents win** — flag the conflict in your report, do not silently resolve it.

If a requirement is genuinely unimplementable as written, stop and say so. Do not substitute your own design.

---

## What the project is

A locally-run, open-source web platform with a VS Code–like interface. It runs an AI coding agent against the user's local project and **renders the agent's work as a human-speed animation**: the file opens in the sidebar, the cursor moves, code is typed line by line, the file is saved, the next file opens. Transport controls — play, pause, speed, step, seek, jump to live.

The animation is the product. Correctness of the playback engine matters more than breadth of features.

---

## Architecture facts you must not get wrong

**The provider layer and the MCP layer are separate.**

- **Provider layer** = model access. Adapters for Anthropic, OpenAI, Google Gemini, and any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, vLLM). One normalized streaming + tool-calling interface. The agent runtime is provider-agnostic.
- **MCP layer** = tools and context, not models. The platform is an MCP **client** (connects to user-configured servers over stdio and streamable HTTP, exposes their tools to the agent) and also an MCP **server** (publishes its own editor/animation tools so external agents can drive it).

Do not route model calls through MCP. Do not build a "MCP provider adapter."

**The Session Event Stream (SES) is the spine.** Append-only timestamped JSONL. Agent runs at machine speed; playback runs at human speed; a buffer decouples them. Live mode is playback near the head of the stream — *not* a separate code path. Seeking backwards uses `checkpoint` keyframes, never a replay from `seq` 0. The exact schema is in `docs/architecture.md`.

---

## Stack — pinned, do not substitute

| Layer | Choice |
|---|---|
| Runtime | Node 22, TypeScript strict mode, ESM |
| Server | Fastify; `ws` for the event socket |
| UI | React 18 + Vite + Tailwind |
| Editor | `monaco-editor` via `@monaco-editor/react` |
| Terminal | `xterm` + `@xterm/addon-fit` |
| Providers | `@anthropic-ai/sdk`, `openai`, `@google/genai`; OpenAI-compatible adapter reuses `openai` with a configurable `baseURL` |
| MCP | `@modelcontextprotocol/sdk` — both client and server |
| Storage | `better-sqlite3` for session metadata; plain JSONL files for SES streams |
| Keychain | `keytar` or equivalent — never plaintext keys on disk |
| Validation | `zod` for every boundary (HTTP, WS, SES events, config) |
| Tests | Vitest for unit/integration; Playwright for UI and playback |
| Lint/format | ESLint + Prettier, enforced in CI |
| Packaging | Node SEA (or Bun compile if SEA blocks on a native dep — justify in the report) |
| CI | GitHub Actions, matrix: `ubuntu-latest`, `macos-latest`, `windows-latest` |
| License | Apache-2.0 |

No additional runtime dependencies without a one-line justification in your report. Prefer the standard library.

---

## Repo layout

```
<PROJECT_NAME>/
├── apps/
│   ├── server/              # Fastify host, WS, static serving
│   └── web/                 # React UI (Vite)
├── packages/
│   ├── ses/                 # Session Event Stream: types, reader, writer, keyframes
│   ├── playback/            # Playback engine: state machine, clock, seek, stepping
│   ├── typing-sim/          # Human typing timing model
│   ├── agent/               # Tool loop, conversation state, cost accounting
│   ├── providers/           # Anthropic / OpenAI / Gemini / OpenAI-compatible adapters
│   ├── mcp/                 # MCP client + MCP server
│   ├── workspace/           # File tree, watcher, git status, path allowlist
│   └── shared/              # Cross-cutting types, zod schemas, logging
├── fixtures/                # Hand-written SES sessions for demos and tests
├── docs/                    # Written by the planning pass — READ, do not edit
├── .github/workflows/
├── LICENSE                  # Apache-2.0
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
└── SECURITY.md
```

Monorepo via npm workspaces. Each `packages/*` is independently unit-testable with no server or browser dependency — `ses`, `playback` and `typing-sim` especially must be pure and headless.

---

## Working protocol

1. **One phase per session.** Read `docs/plan.md`, find the current phase, implement only that phase.
2. **Read the specs for the capabilities in that phase before writing any code.** Quote the REQ ids you are implementing at the top of your report.
3. **Tests alongside code, not after.** Each acceptance criterion in the specs maps to a named test. Name tests so the mapping is obvious: `REQ-PLAYBACK-004: seeking backwards restores from nearest checkpoint`.
4. **Before declaring a phase done, run:** `npm run typecheck && npm run lint && npm run test && npm run build`. All four green. If any fails, the phase is not done — fix it, do not report around it.
5. **Conventional commits.** Small, focused. `feat(playback): add step-group navigation`.
6. **Never commit keys, tokens, `.env` files, or fixtures containing real credentials.**
7. **Stop at the end of the phase and report.** Do not roll into the next phase unasked.

---

## Guardrails

- TypeScript strict. No `any`. No `@ts-ignore` without a comment explaining why and a linked issue.
- Every agent filesystem write goes through `packages/workspace`'s path allowlist. No exceptions, no direct `fs` calls from `packages/agent`.
- Every agent run is wrapped in a git-backed checkpoint before the first write.
- Shell execution is confined to the workspace root. No `cd` escapes, no absolute paths outside it.
- Cross-platform from day one: use `node:path` everywhere, never hardcode `/`, handle case-insensitive filesystems, account for Windows file-watch behaviour differences.
- The playback engine must be deterministic. Given the same SES file and the same seek target, the resulting editor state is identical every time. Test this explicitly.
- No network calls in unit tests. Provider adapters get recorded fixtures.

---

## Definition of done, per phase

- [ ] Every REQ id assigned to the phase has a corresponding passing test
- [ ] `typecheck`, `lint`, `test`, `build` all green locally
- [ ] CI green on ubuntu, macos and windows
- [ ] The phase's **Demo** from `docs/plan.md` actually runs, with the exact commands to reproduce it in your report
- [ ] README updated if the demo commands changed
- [ ] No new TODOs without an accompanying GitHub issue

---

## Report format

At the end of the phase, output — and nothing more:

```
## Phase N complete

Requirements implemented: REQ-..., REQ-...

Demo:
  <exact commands>

Checks: typecheck ✓  lint ✓  test ✓ (N passing)  build ✓

New dependencies: <name> — <one-line justification>   (or: none)

Spec conflicts found: <description>   (or: none)

Deferred: <anything in the phase not done, and why>
```

---

## Current task

**Bootstrap the repo and implement Phase 1 only.**

Phase 1 is the walking skeleton: the SES schema, the JSONL reader/writer with keyframes, the playback engine, the human typing simulator, and a Monaco surface that animates a **hand-written fixture session** from `fixtures/`. Transport controls fully working — play, pause, speed 0.25×–32×, step forward/back, seek.

**Phase 1 must demo with no API key and no LLM call.** If your implementation needs one, you have misread the plan — stop and say so.

Then stop and report.
