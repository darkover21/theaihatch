# MCP client

## Purpose
Connect the agent to user-configured MCP tools, resources, and prompts. Isolate each server and place explicit policy at every tool boundary.

## Requirements

### REQ-MPC-001 — Configure MCP servers
Users shall configure named stdio or streamable HTTP servers with transport-specific fields, environment references, enabled state, and startup timeout.

**Acceptance**
- Given a valid stdio configuration, when enabled, then the process starts with the configured executable, arguments, working directory, and resolved environment.
- Given a valid streamable HTTP configuration, when enabled, then the client connects to its URL using configured non-secret headers and keychain-backed secret references.

### REQ-MPC-002 — Discover capabilities
The client shall discover and refresh each server's tools, resources, and prompts and retain server-qualified identifiers.

**Acceptance**
- Given a connected server, when discovery completes, then its advertised tools, resources, and prompts are indexed under its server name.
- Given two servers expose the same tool name, when listed, then both remain addressable by distinct qualified identifiers.

### REQ-MPC-003 — List tools in the UI
The UI shall display each discovered tool's server, name, description, input schema, connection state, and approval policy.

**Acceptance**
- Given discovered tools, when the MCP panel opens, then all listed fields and current policies are visible.
- Given discovery changes, when refreshed, then removed tools disappear and new tools appear without restarting the app.

### REQ-MPC-004 — Enforce per-tool policy
Every MCP tool shall have an `always ask`, `allow`, or `deny` policy, defaulting to `always ask`.

**Acceptance**
- Given `always ask`, when the agent requests the tool, then execution waits for explicit approval.
- Given `deny`, when requested, then the server is not called and a denied result returns to the agent.

### REQ-MPC-005 — Call tools safely
Approved calls shall validate arguments against the discovered input schema, use timeouts and cancellation, and return normalized content or error results.

**Acceptance**
- Given invalid arguments, when a call is attempted, then it is rejected locally before server invocation.
- Given an approved long-running call, when the run is cancelled, then cancellation is propagated and a cancelled result is recorded.

### REQ-MPC-006 — Isolate failures
Connection, protocol, timeout, and process failures from one MCP server shall not terminate the run or other server connections.

**Acceptance**
- Given one of two servers crashes, when its tool is called, then that call fails while the other server remains usable.
- Given a server repeatedly fails startup, when its retry limit is reached, then it is marked unavailable without crashing the local server.

## Dependencies
- None

## Out of scope
- Model routing through MCP
- Installing MCP servers
