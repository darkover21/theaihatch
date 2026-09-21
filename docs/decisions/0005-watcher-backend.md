# ADR-0005: Platform-native workspace watcher backend

## Decision

Use one recursive `fs.watch` handle on macOS and Windows. On Linux, use lazy per-directory handles opened when the explorer or file routes touch a directory. Keep the backend behind `WatchBackend` so a future native watcher can replace it without changing workspace classification or producer logic.

## Rationale

Recursive setup is constant-time on the supported macOS and Windows implementations. Node's Linux recursive mode walks the tree and consumes one inotify watch per directory, so it is deliberately not used there. The watcher classifies events from `lstat` state rather than trusting the platform event label.

## Consequences

Large macOS/Windows workspaces avoid startup walks and watcher-map churn. Linux only observes directories the user has opened; this matches the lazy explorer and keeps resource use bounded.
