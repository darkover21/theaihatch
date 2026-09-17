# Packaging

## Purpose
Deliver a self-contained local application for Windows, macOS, and Linux. Make first launch predictable without requiring Node or a package manager.

## Requirements

### REQ-PKG-001 — Produce one binary per OS
Release builds shall produce a self-contained executable for each supported Windows, macOS, and Linux target with server and built UI assets embedded.

**Acceptance**
- Given a clean supported machine without Node, when its binary starts, then the local server and UI run.
- Given a release, when artifacts are inspected, then each OS target has one executable payload plus checksum and signature metadata.

### REQ-PKG-002 — Run first-use setup
First launch shall select or create the data directory, initialize SQLite, verify keychain access, and present workspace and provider setup.

**Acceptance**
- Given no prior config, when the binary starts, then setup completes before the main workspace view is shown.
- Given setup is interrupted, when the binary restarts, then it resumes safely without duplicate or corrupt state.

### REQ-PKG-003 — Select a local port
The server shall bind to a configured loopback port or, if unavailable, the next available port in a bounded range and report the chosen URL.

**Acceptance**
- Given the configured port is free, when starting, then the server binds to that port on loopback only.
- Given the configured port is occupied, when starting, then the server binds to the first free fallback port and records it for that launch.

### REQ-PKG-004 — Open the browser
After readiness succeeds, startup shall open the system default browser to the chosen localhost URL unless disabled by configuration.

**Acceptance**
- Given auto-open is enabled, when health readiness passes, then one browser-open request is issued with the actual port.
- Given auto-open is disabled, when readiness passes, then no browser is opened and the URL is printed.

### REQ-PKG-005 — Use OS config locations
Configuration and application data shall reside in platform-standard per-user locations and shall be displayed in settings.

**Acceptance**
- Given each supported OS, when first launch completes, then config and data resolve to that OS's standard per-user directories.
- Given settings is opened, when paths are shown, then they match the directories in active use.

### REQ-PKG-006 — Check for updates
The app shall check signed release metadata at startup at most once per 24 hours and notify without downloading or installing automatically.

**Acceptance**
- Given a newer valid signed release, when a check completes, then its version and release link are shown.
- Given offline mode, invalid metadata, or a failed check, when startup continues, then local functionality is unaffected and no update is offered.

## Dependencies
- editor-surface
- terminal-panel
- agent-runtime
- provider-adapters
- mcp-client
- mcp-server

## Out of scope
- Automatic installation of updates
- App-store distribution

