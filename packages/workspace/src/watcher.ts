import { promises as fs, watch, type FSWatcher, type Stats } from "node:fs";
import path from "node:path";
import { WorkspaceTree } from "./tree.js";

export type WorkspaceChangeKind = "create" | "modify" | "delete" | "rename";
export interface WorkspaceChange { kind: WorkspaceChangeKind; path: string; previousPath?: string; }
export type WorkspaceChangeListener = (change: WorkspaceChange) => void;

interface FileIdentity { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; birthtimeNs: bigint; isDirectory: boolean; }
interface HeldDelete { path: string; timer: ReturnType<typeof setTimeout>; }

function identityKey(identity: FileIdentity): string {
  return `${identity.dev}:${identity.ino}:${identity.mtimeNs}:${identity.size}`;
}

function identityFrom(stats: Stats): FileIdentity {
  const precise = stats as Stats & { mtimeNs?: bigint; ctimeNs?: bigint; birthtimeNs?: bigint };
  return {
    dev: BigInt(stats.dev), ino: BigInt(stats.ino), size: BigInt(stats.size),
    mtimeNs: precise.mtimeNs ?? BigInt(Math.round(stats.mtimeMs * 1_000_000)),
    ctimeNs: precise.ctimeNs ?? BigInt(Math.round(stats.ctimeMs * 1_000_000)),
    birthtimeNs: precise.birthtimeNs ?? BigInt(Math.round(stats.birthtimeMs * 1_000_000)),
    isDirectory: stats.isDirectory(),
  };
}

function changed(previous: FileIdentity, current: FileIdentity): boolean {
  return previous.dev !== current.dev || previous.ino !== current.ino || previous.size !== current.size
    || previous.mtimeNs !== current.mtimeNs || previous.ctimeNs !== current.ctimeNs;
}

export class WorkspaceWatcher {
  private readonly listeners = new Set<WorkspaceChangeListener>();
  private readonly snapshots = new Map<string, FileIdentity>();
  private readonly heldDeletes = new Map<string, HeldDelete>();
  private readonly handles = new Set<FSWatcher>();
  private running = false;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly tree: WorkspaceTree) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.openWatcher(this.tree.root.canonicalPath, process.platform === "darwin" || process.platform === "win32");
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const held of this.heldDeletes.values()) clearTimeout(held.timer);
    this.heldDeletes.clear();
    for (const handle of this.handles) handle.close();
    this.handles.clear();
    await this.flushing;
  }

  subscribe(listener: WorkspaceChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private openWatcher(directory: string, recursive: boolean): void {
    try {
      const handle = watch(directory, { persistent: false, recursive }, (_eventType, filename) => {
        if (filename !== null) this.onRaw(directory, filename.toString());
      });
      handle.on("error", () => { handle.close(); this.handles.delete(handle); });
      this.handles.add(handle);
    } catch {
      // The directory can disappear between workspace open and watcher setup.
    }
  }

  private onRaw(directory: string, filename: string): void {
    if (!this.running || filename.includes("\0")) return;
    const absolute = path.resolve(directory, filename);
    let relative: string;
    try { relative = this.tree.normalize(absolute); } catch { return; }
    void this.classify(relative, absolute);
  }

  private async classify(relative: string, absolute: string): Promise<void> {
    if (!this.running || this.tree.isIgnored(relative, false)) return;
    const current = await fs.lstat(absolute, { bigint: true }).then((stats) => identityFrom(stats as unknown as Stats), () => null);
    const previous = this.snapshots.get(relative);
    if (current === null) {
      if (previous === undefined) return;
      this.snapshots.delete(relative);
      const key = identityKey(previous);
      const timer = setTimeout(() => { this.heldDeletes.delete(key); this.emit({ kind: "delete", path: relative }); }, 150);
      this.heldDeletes.set(key, { path: relative, timer });
      return;
    }
    this.snapshots.set(relative, current);
    const held = this.heldDeletes.get(identityKey(current));
    if (held !== undefined) {
      clearTimeout(held.timer);
      this.heldDeletes.delete(identityKey(current));
      this.emit({ kind: "rename", previousPath: held.path, path: relative });
      return;
    }
    if (previous === undefined) {
      this.emit({ kind: "create", path: relative });
      return;
    }
    if (changed(previous, current)) this.emit({ kind: "modify", path: relative });
  }

  private emit(change: WorkspaceChange): void {
    if (!this.running) return;
    for (const listener of this.listeners) listener(change);
  }
}
