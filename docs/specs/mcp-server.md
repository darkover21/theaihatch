# MCP server

## Purpose
Publish platform actions as MCP tools so an external agent can drive the same SES-backed animation. Preserve the local safety and approval boundaries.

## Requirements

### REQ-MPS-001 — Serve localhost streamable HTTP
The platform shall expose MCP over streamable HTTP bound only to loopback interfaces on the local server port.

**Acceptance**
- Given the platform is running, when a loopback client connects to the MCP endpoint, then protocol initialization succeeds.
- Given a non-loopback interface, when connection is attempted, then no listener accepts it.

### REQ-MPS-002 — Authenticate MCP clients
Each first run shall generate a random bearer token stored in the OS keychain; every MCP request after discovery of the endpoint shall require it.

**Acceptance**
- Given a missing or invalid token, when an MCP request is sent, then it receives an authentication error and no tool runs.
- Given a valid keychain token, when a request is sent from loopback, then it proceeds to tool validation.

### REQ-MPS-003 — Publish platform tools
The server shall publish tools for open file, edit, save, run command, and animate step with complete input schemas.

**Acceptance**
- Given an initialized client, when it lists tools, then all five tool classes are present with JSON schemas.
- Given schema-invalid input, when a tool is called, then it is rejected without workspace or SES changes.

### REQ-MPS-004 — Route actions through SES
Successful external actions shall pass through platform safety checks and emit the same granular SES events as internal-agent actions.

**Acceptance**
- Given an authorized edit, when called externally, then granular edit and save events drive the visible animation.
- Given an authorized command, when called externally, then its command and streamed output appear in the terminal projection.

### REQ-MPS-005 — Serialize control sessions
Only one internal or external agent shall hold workspace mutation control at a time; additional callers receive a busy response.

**Acceptance**
- Given an internal run holds control, when an external mutation tool is called, then it receives a busy error and no mutation occurs.
- Given control is released, when the external client retries, then the call can proceed.

### REQ-MPS-006 — Apply approval policy
External tool calls shall obey the same destructive-command, path, dry-run, and review gates as the internal agent.

**Acceptance**
- Given an external call requests a destructive command, when policy requires confirmation, then it waits for local-user approval.
- Given dry-run mode, when an external edit is called, then its proposed change is recorded without modifying the workspace.

## Dependencies
- session-stream
- workspace
- safety-and-checkpoints

## Out of scope
- Non-local MCP clients
- Model access or model routing

