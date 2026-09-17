# Architecture

## System boundary

- The AI Hatch is one local Node 22 process serving an embedded React application over loopback HTTP.
- The server owns workspace access, agent execution, SES persistence, SQLite, provider adapters, MCP connections, shell processes, and policy enforcement.
- The browser owns presentation, transport input, Monaco, xterm.js, and deterministic projection of server-supplied SES events.
- No cloud service, account, remote collaboration path, Electron shell, or Tauri shell exists.

## Module boundaries

### `packages/ses`

- Owns the event types, runtime validation, JSONL reader/writer, sequence allocation, checkpoint creation, indexes, and recovery scans.
- Exposes append, subscribe, ranged read, checkpoint lookup, and integrity status.
- Does not know about React, providers, MCP, Monaco, or xterm.js.

### `packages/playback`

- Owns playback state, scheduling, speed, event/step navigation, seek, projection state, and behind-live calculation.
- Consumes only SES reader/subscription interfaces.
- Uses one path for growing live streams and closed replay streams.

### `packages/typing`

- Owns seeded character timing, pause classification, instant-mode thresholds, cursor easing, and scroll-follow targets.
- Produces presentation schedules; never changes SES events.

### `packages/workspace`

- Owns canonical root selection, path normalization, file operations, ignore evaluation, file watching, file tree, and Git status.
- Every agent-originated mutation enters through the safety facade.

### `packages/agent`

- Owns conversation state, system-prompt composition, the provider-neutral tool loop, cancellation, retry, usage, and run limits.
- Depends on the provider interface; contains no provider SDK types.
- Emits intent and action results through the SES writer.

### `packages/providers`

- Owns a normalized `ProviderAdapter` contract and the Anthropic, OpenAI, Gemini, and OpenAI-compatible implementations.
- Owns provider configuration, connection tests, model discovery, error classification, and usage normalization.
- Retrieves secrets through the keychain interface; never persists secret values.

### `packages/mcp-client`

- Owns outbound stdio and streamable HTTP connections, discovery, qualified capability names, per-tool approval policy, validation, timeouts, and server isolation.
- Supplies tools, resources, and prompts to the agent; never routes model requests.

### `packages/mcp-server`

- Owns the loopback streamable HTTP MCP endpoint, bearer authentication, control lease, schemas, and mapping of external calls to platform actions.
- Routes every mutation through the same safety, review, workspace, terminal, and SES services used by the internal agent.

### `packages/safety`

- Owns canonical-path allowlisting, command classification, approvals, dry-run behavior, Git-backed run checkpoints, revert, and security audit records.
- Is mandatory for internal-agent and external-MCP mutations.

### `packages/storage`

- Owns SQLite migrations and repositories for sessions, conversations, runs, usage, configuration references, reviews, and safety audit records.
- Stores event bodies only in per-session JSONL files.

### `apps/server`

- Composes Fastify HTTP routes, `ws` live event notification, static UI assets, lifecycle, port selection, keychain access, and process supervision.
- Keeps authoritative state and rejects browser-originated filesystem paths that bypass workspace identifiers.

### `apps/web`

- Owns React shell, Monaco models, xterm.js views, explorer, step list, review UI, provider/MCP settings, and transport controls.
- Applies projected states from the playback package and sends commands through typed HTTP/WebSocket clients.

### `packages/packaging`

- Embeds built web assets and server code into one self-contained executable per OS.
- Owns platform paths, first-run setup, update metadata checks, checksums, and launch behavior.

## Provider and MCP separation

- Provider adapters access models and normalize streaming, tool calls, usage, cancellation, and errors.
- The agent runtime sees only `ProviderAdapter`; it never sees Anthropic, OpenAI, Gemini, or compatible-endpoint SDK types.
- The MCP client connects the agent to tools, resources, and prompts supplied by user-configured servers.
- The MCP server exposes The AI Hatch tools to external agents.
- No MCP transport is used for model routing.

## Data flow

```text
Internal path
user prompt
  -> agent runtime
  -> provider adapter -> model stream -> normalized tool calls
  -> policy / approval -> workspace or terminal action
  -> SES writer -> events.jsonl + in-memory append notification
  -> unbounded logical buffer
  -> playback engine -> typing scheduler / projector
  -> React shell -> Monaco + xterm.js + step/review panels

External-agent path
external agent
  -> loopback authenticated MCP server
  -> control lease -> policy / approval -> workspace or terminal action
  -> SES writer -> same buffer -> same playback engine -> same UI

Replay and seek
events.jsonl + checkpoint index
  -> SES reader -> nearest preceding checkpoint
  -> restore touched-file snapshots -> replay through target sequence
  -> playback engine -> same projector -> same UI
```

- The producer appends at machine speed.
- The consumer schedules at human speed.
- The logical buffer has no event-dropping limit; durable JSONL is its overflow backing store.
- Live mode is not separate. It is playback whose cursor is at or near the current stream head.
- Behind-live is the count of completed step boundaries between the cursor and head.
- Jump-to-live consumes the same events through an accelerated scheduler.

## Session Event Stream schema

```ts
export type SessionId = string;
export type StepId = string;
export type ToolCallId = string;
export type TerminalCommandId = string;
export type WorkspacePath = string; // normalized, slash-separated, root-relative

export interface Position {
  line: number;   // zero-based
  column: number; // zero-based UTF-16 code-unit offset
}

export interface TextRange {
  start: Position;
  end: Position; // exclusive
}

export type StepOutcome = "succeeded" | "failed" | "cancelled" | "denied";
export type DiffKind = "added" | "modified" | "deleted";
export type TerminalStream = "stdout" | "stderr";

export interface SesPayloadMap {
  workspace_open: {
    rootName: string;
    canonicalRoot: string;
  };
  file_open: {
    path: WorkspacePath;
    preview: boolean;
  };
  file_close: {
    path: WorkspacePath;
  };
  tab_focus: {
    path: WorkspacePath;
  };
  cursor_move: {
    path: WorkspacePath;
    position: Position;
  };
  selection_change: {
    path: WorkspacePath;
    selections: TextRange[];
    primary: number;
  };
  scroll: {
    path: WorkspacePath;
    scrollTop: number;
    scrollLeft: number;
  };
  edit_insert: {
    path: WorkspacePath;
    position: Position;
    text: string;
  };
  edit_delete: {
    path: WorkspacePath;
    range: TextRange;
    deletedText: string;
  };
  edit_replace: {
    path: WorkspacePath;
    range: TextRange;
    deletedText: string;
    insertedText: string;
  };
  file_create: {
    path: WorkspacePath;
  };
  file_save: {
    path: WorkspacePath;
    contentHash: string;
  };
  file_delete: {
    path: WorkspacePath;
  };
  file_rename: {
    from: WorkspacePath;
    to: WorkspacePath;
  };
  terminal_command: {
    commandId: TerminalCommandId;
    command: string;
    cwd: WorkspacePath | ".";
    shell: string;
  };
  terminal_output: {
    commandId: TerminalCommandId;
    stream: TerminalStream;
    chunk: string;
    eof: boolean;
    exitCode?: number;
    signal?: string;
  };
  agent_thought: {
    text: string;
    visibility: "summary" | "hidden";
  };
  agent_tool_call: {
    callId: ToolCallId;
    server?: string;
    tool: string;
    arguments: unknown;
  };
  agent_tool_result: {
    callId: ToolCallId;
    ok: boolean;
    content: unknown;
    errorCode?: string;
  };
  step_begin: {
    stepId: StepId;
    label: string;
    primaryPath?: WorkspacePath;
  };
  step_end: {
    stepId: StepId;
    outcome: StepOutcome;
    summary?: string;
  };
  checkpoint: {
    reason: "cadence" | "final";
    files: Array<{
      path: WorkspacePath;
      content: string | null; // null means touched and deleted at this point
      contentHash: string | null;
    }>;
  };
  diff_marker: {
    path: WorkspacePath;
    range: TextRange;
    kind: DiffKind;
    hunkId: string;
  };
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    source: "ses" | "playback" | "agent" | "provider" | "mcp" | "workspace" | "terminal";
    details?: unknown;
  };
}

export type SesEventType = keyof SesPayloadMap;

export type SesEvent<T extends SesEventType = SesEventType> = {
  [K in T]: {
    seq: number; // nonnegative, contiguous, monotonic integer
    t: number;   // nonnegative integer milliseconds since session start; nondecreasing
    type: K;
    payload: SesPayloadMap[K];
  }
}[T];

export type AnySesEvent = SesEvent;

export interface SessionMetadata {
  id: SessionId;
  workspacePath: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  status: "created" | "running" | "completed" | "cancelled" | "failed";
  streamPath: string;
  headSeq: number;
  durationMs: number;
  providerId: string | null;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  integrity: "unchecked" | "valid" | "recovered" | "corrupt";
}
```

### SES invariants

- Each UTF-8 JSONL line is exactly one `AnySesEvent`.
- `seq` starts at 0 and increases by exactly 1.
- `t` is an integer measured from session start and never decreases.
- Edit events carry a path, position or range, and text delta. Whole-file replacement is prohibited outside `checkpoint`.
- A checkpoint contains the complete current content, or deletion marker, for every file touched before it.
- A cadence checkpoint follows each 500 non-checkpoint events; this bounds replay work by event count regardless of event byte size.
- Seek restores the nearest checkpoint at or before the target and replays forward. It never starts at sequence 0 when a preceding checkpoint exists.

## Persistence layout

```text
<data-dir>/
  config.json
  sessions.sqlite
  sessions/
    <session-id>/
      events.jsonl
      index.sqlite
      recovery.jsonl   # only when a truncated tail was quarantined
```

- `sessions.sqlite` stores session metadata, conversations, runs, usage, reviews, approval policies, and audit records.
- `index.sqlite` maps sequence ranges, timestamps, checkpoints, steps, and file occurrences to JSONL byte offsets.
- JSONL is authoritative for event bodies; SQLite indexes are rebuildable.
- Provider keys and MCP bearer tokens exist only in the OS keychain.

## Process and threading model

- One main Node process owns Fastify, `ws`, orchestration, SQLite coordination, provider/MCP network I/O, and child-process supervision.
- Worker threads handle JSONL validation/index rebuilds, checkpoint hashing, Git status scans, and large diff computation.
- One serialized SES append queue per session assigns sequence and timestamp values and commits JSONL before notifying subscribers.
- Each agent run has one abort tree covering provider requests, MCP calls, workspace tools, and terminal child processes.
- Stdio MCP servers and terminal commands run as supervised child processes with separate stdout and stderr drains.
- The browser connects by HTTP for commands and snapshots and by WebSocket for append notifications and run state.
- SQLite uses WAL mode; one storage service serializes migrations and transactional writes.
- Browser projection runs on the UI thread; checkpoint restoration and large SES range decoding use a Web Worker.

## Non-goals

- No remote or multi-user collaboration. Single user, single machine.
- No cloud hosting, no account system, no telemetry.
- No VS Code extension host. It looks like VS Code; it is not VS Code.
- No debugger.
- No language servers beyond what Monaco provides built-in.
- No mobile or tablet layout.
- No model fine-tuning, no embeddings store, no RAG pipeline in v1.
- Not a VS Code extension. Standalone.
