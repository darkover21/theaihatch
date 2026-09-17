# ADR 0004 — MCP server authentication

## Context
Inbound MCP control can edit files and run commands. Loopback binding blocks remote network access but does not distinguish local processes or protect against browser-originated requests.

## Decision
Bind streamable HTTP only to IPv4 and IPv6 loopback and require a random bearer token generated on first run and stored in the OS keychain. Non-local access is unsupported in v1.

## Consequences
External agents need a local token handoff. There is no certificate or remote identity setup, and a caller without both loopback access and the token cannot invoke tools.

