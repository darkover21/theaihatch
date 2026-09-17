# Two-prompt hand-off — how to use these

## Phase 1 fixture demo

The walking skeleton is a local, provider-free playback demo. It uses the hand-written SES fixture in `fixtures/sessions/walking-skeleton/events.jsonl`; no API key or LLM call is required.

```sh
npm install
npm run dev
```

Open the printed Vite URL. Use play/pause, the 0.25×–32× speed selector, event and step controls, the timeline, file occurrences, and Jump to live to inspect the replay.

Development checks:

```sh
npm run typecheck
npm run lint
npm run test
npm run build
```

The rest of this file documents the planning hand-off that produced the Phase 1 contract.

Codex writes the specs and plan (cheap pass). Gemini writes the code (expensive pass). Splitting them keeps the expensive model from burning tokens on architecture it would have to redo anyway.

## Before you start

1. Create the repo and `git init` it.
2. In **both** prompt files, replace:
   - `<PROJECT_NAME>` — the project name
   - `<REPO_PATH>` — absolute path to the repo

Do the replacement in both files. The prompts reference each other's assumptions.

## Step 1 — Codex

Paste [prompt-codex-specs-and-plan.md](prompt-codex-specs-and-plan.md) into Codex with the repo attached.

Expect it to write:

```
docs/specs/*.md          one per capability (15 of them)
docs/architecture.md     module boundaries + the SES TypeScript schema
docs/plan.md             6 phases, each with a demo
docs/decisions/*.md      ADRs, max 8
docs/open-questions.md
```

## Step 2 — Check Codex's output before paying Gemini

Five minutes here saves a rewrite later.

- [ ] A spec file exists for **every** capability in the table. Missing ones mean Codex ran out of budget — re-run for just the missing ids.
- [ ] Every `REQ-` has **Given/When/Then** acceptance criteria. A requirement without one is a wish, and Gemini cannot test it.
- [ ] `docs/architecture.md` has the SES schema as **complete, copy-pasteable TypeScript**. If it is prose, re-run — this is the one artifact Gemini cannot improvise.
- [ ] `docs/architecture.md` states the provider layer and the MCP layer separately. If MCP appears as a way to reach models, Codex misread the brief. Re-run with that section emphasized.
- [ ] **Phase 1 in `docs/plan.md` needs no API key.** If it does, the phasing is wrong and everything downstream inherits the problem. Re-run Codex on just the phasing section.
- [ ] The non-goals list is present and specific.

Commit `docs/` before moving on. It is the contract.

## Step 3 — Gemini, one phase at a time

Paste [prompt-gemini-implementation.md](prompt-gemini-implementation.md). Change only the **Current task** block at the bottom for each phase — everything above it stays identical every time.

Phase order is fixed in `docs/plan.md`:

| Phase | Lands |
|---|---|
| 1 | SES + playback engine + typing sim + Monaco, animating a fixture. **No LLM.** |
| 2 | Real workspace — file tree, tabs, git status, terminal |
| 3 | Agent runtime + one provider |
| 4 | Remaining providers + MCP client and server |
| 5 | Safety, checkpoints, review/approval |
| 6 | Packaging, CI matrix, release, OSS hygiene |

Do not let it run two phases in one go. The report format at the end of the prompt is the gate — if it did not print the checks as green, the phase is not done.

## Iterating

- **One capability is wrong?** Re-run Codex with just that capability's section and the output contract. Do not regenerate all 15 specs.
- **Gemini drifted from the stack?** The pinned table is in the prompt; point at the specific row rather than re-explaining.
- **Spec turned out unimplementable?** Fix `docs/specs/`, commit it, then re-run the phase. The docs stay the source of truth — never let the code and specs diverge silently.

## Why the prompts are shaped this way

Two things in the original brief would have produced the wrong architecture:

**"Connected to any LLM by MCP."** MCP connects agents to tools and data, not to models. These are two independent layers, and conflating them produces an adapter that cannot stream, cannot tool-call properly, and cannot swap providers. Both prompts state the split explicitly.

**No session format.** Live view, replay, seek, speed and stepping are one data structure wearing five hats. Without naming it up front, a model builds live-streaming and replay as separate subsystems and then cannot make seek work. The prompts hand over the Session Event Stream as a given, with two non-negotiable rules: the agent's speed is decoupled from playback speed by a buffer (so live mode is just playback near the head of the stream), and backwards seek restores from keyframes rather than replaying from the beginning.
