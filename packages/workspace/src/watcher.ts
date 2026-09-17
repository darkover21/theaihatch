import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { WorkspaceTree } from "./tree.js";

export type WorkspaceChangeKind = "create" | "modify" | "delete" | "rename";

export interface WorkspaceChange {
  kind: WorkspaceChangeKind;
  path: string;
  previousPath?: string;
}

export type WorkspaceChangeListener = (change: WorkspaceChange) => void;

interface PendingDelete {
  path: string;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkspaceWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly listeners = new Set<WorkspaceChangeListener>();
  private readonly pendingDeletes: PendingDelete[] = [];
  private running = false;

  constructor(private readonly tree: WorkspaceTree) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.reconcileDirectories();
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const pending of this.pendingDeletes.splice(0)) clearTimeout(pending.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  subscribe(listener: WorkspaceChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async reconcileDirectories(): Promise<void> {
    if (!this.running) return;
    const directories = new Set<string>();
    const visit = async (relative: string): Promise<void> => {
      const absolute = this.tree.absolute(relative);
      directories.add(absolute);
      let entries;
      try {
        entries = await fs.readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = relative === "." ? entry.name : path.posix.join(relative, entry.name);
        if (this.tree.isIgnored(child, true)) continue;
        await visit(child);
      }
    };
    await visit(".");
    for (const directory of directories) {
      if (this.watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, (eventType, filename) => {
          void this.handleNativeEvent(directory, eventType, filename === null ? null : filename.toString());
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(directory);
        });
        this.watchers.set(directory, watcher);
      } catch {
        // A directory may disappear between the scan and watch call.
      }
    }
    for (const [directory, watcher] of this.watchers) {
      if (!directories.has(directory)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    }
  }

  private async handleNativeEvent(directory: string, eventType: string, filename: string | null): Promise<void> {
    if (!this.running || filename === null || filename.includes("\u0000")) return;
    const absolute = path.join(directory, filename);
    let relative: string;
    try {
      relative = this.tree.normalize(absolute);
    } catch {
      return;
    }
    const exists = await fs.stat(absolute).then(() => true, () => false);
    const kind = eventType === "change" ? "modify" : exists ? "create" : "delete";
    if (this.tree.isIgnored(relative, false)) return;
    if (kind === "delete") {
      const timer = setTimeout(() => {
        const index = this.pendingDeletes.findIndex((pending) => pending.path === relative);
        if (index >= 0) this.pendingDeletes.splice(index, 1);
        this.emit({ kind: "delete", path: relative });
      }, 60);
      this.pendingDeletes.push({ path: relative, timer });
    } else if (kind === "create") {
      const parent = path.posix.dirname(relative);
      const matchIndex = this.pendingDeletes.findIndex((pending) => path.posix.dirname(pending.path) === parent);
      if (matchIndex >= 0) {
        const pending = this.pendingDeletes[matchIndex];
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.pendingDeletes.splice(matchIndex, 1);
          this.emit({ kind: "rename", previousPath: pending.path, path: relative });
        }
      } else {
        this.emit({ kind: "create", path: relative });
      }
    } else {
      this.emit({ kind: "modify", path: relative });
    }
    await this.reconcileDirectories();
  }

  private emit(change: WorkspaceChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
