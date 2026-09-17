# Workspace

## Purpose
Open and observe one local project. Supply file navigation, repository state, and external-change events to the rest of the platform.

## Requirements

### REQ-WKS-001 — Open a folder
The user shall select one local folder, which becomes the canonical workspace root for the session.

**Acceptance**
- Given a readable folder, when it is selected, then `workspace_open` is emitted with its canonical path and the explorer loads.
- Given an unreadable or missing folder, when opening is attempted, then no workspace is activated and an actionable error is shown.

### REQ-WKS-002 — Display the file tree
The explorer shall lazily display files and folders under the workspace root in stable name order.

**Acceptance**
- Given a folder with files and subfolders, when expanded, then its direct children appear in stable folder-first name order.
- Given a file is selected, when it is readable, then a tab opens and `file_open` is emitted.

### REQ-WKS-003 — Apply ignore rules
Discovery and watching shall honor the workspace `.gitignore` and always ignore `.git` internals and `node_modules`.

**Acceptance**
- Given a path matched by `.gitignore`, when the tree is built, then that path is absent.
- Given nested `node_modules` and `.git` directories, when watching starts, then no events from their descendants enter the SES.

### REQ-WKS-004 — Decorate Git status
Visible paths shall show staged, modified, untracked, renamed, deleted, or conflicted repository status when the workspace is a Git worktree.

**Acceptance**
- Given a modified tracked file, when status refreshes, then its file and ancestor folder receive the modified decoration.
- Given a non-Git folder, when it opens, then the explorer works without Git decorations or errors.

### REQ-WKS-005 — Watch external changes
The workspace shall detect external create, modify, delete, and rename operations and reconcile tree and open buffers.

**Acceptance**
- Given a clean open file, when it changes externally, then its buffer reloads and the change is identified as external.
- Given an unsaved open buffer, when its file changes externally, then the buffer is preserved and a conflict prompt is shown.

### REQ-WKS-006 — Normalize workspace paths
All event paths shall be slash-separated, workspace-relative, traversal-free paths with original filesystem case preserved.

**Acceptance**
- Given a file under the root, when an event is emitted, then its path is relative and uses `/` separators.
- Given a path resolving outside the root, when normalization is attempted, then it is rejected.

## Dependencies
- session-stream

## Out of scope
- Multiple workspace roots
- Remote filesystems

