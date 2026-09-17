# Editor surface

## Purpose
Provide the VS Code-like viewing surface where SES projections become visible. Preserve familiar navigation while keeping playback authoritative.

## Requirements

### REQ-EDT-001 — Render the application shell
The UI shall provide an activity bar, explorer sidebar, multi-tab editor area, bottom panel, status area, and transport controls.

**Acceptance**
- Given the app is loaded, when a workspace opens, then every shell region is present and keyboard reachable.
- Given the sidebar or bottom panel is toggled, when layout changes, then the editor resizes without losing cursor or tab state.

### REQ-EDT-002 — Use Monaco multi-tab editing
Monaco shall render one model per open path with tab focus, close, dirty-state, and restored view state.

**Acceptance**
- Given two open files, when their tabs are alternated, then each restores its cursor and scroll position.
- Given a dirty tab, when close is requested outside playback, then the user is prompted to save or discard.

### REQ-EDT-003 — Render code affordances
The editor shall provide Monaco syntax highlighting, a minimap, line numbers, selection rendering, and SES diff-gutter markers.

**Acceptance**
- Given a recognized extension, when its file opens, then the registered Monaco language highlighting is active.
- Given a `diff_marker`, when projected, then the affected line range has the matching added, modified, or deleted gutter decoration.

### REQ-EDT-004 — Lock edits during playback
All editor models shall be read-only while state is `playing`, `seeking`, or `at-live-head`.

**Acceptance**
- Given playback is running, when text input is attempted, then file content and SES remain unchanged.
- Given playback is paused on a recorded session, when text input is attempted, then it remains disabled unless the session has been exited to workspace mode.

### REQ-EDT-005 — Project SES UI events
File, tab, cursor, selection, scroll, edit, and save events shall update Monaco and the shell in strict sequence order.

**Acceptance**
- Given a `file_open` followed by `cursor_move`, when projected, then the named tab is focused before the cursor moves.
- Given an edit position inconsistent with current content, when projected, then playback enters error without applying later events.

### REQ-EDT-006 — Provide themes
The UI shall start with a dark theme and allow selection of a light theme, applying it to Monaco, xterm.js, and the shell.

**Acceptance**
- Given first run, when the UI loads, then the dark theme is active.
- Given the light theme is selected, when the app reloads, then the selection persists and all three surfaces use it.

## Dependencies
- playback-engine

## Out of scope
- VS Code extension APIs
- Arbitrary VS Code theme package compatibility
- Language servers beyond Monaco built-ins
