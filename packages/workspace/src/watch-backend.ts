import { watch, type FSWatcher } from "node:fs";

export interface WatchBackend {
  open(directory: string, recursive: boolean, onEvent: (filename: string | null) => void): FSWatcher;
}

export const nodeWatchBackend: WatchBackend = {
  open(directory, recursive, onEvent) {
    return watch(directory, { persistent: false, recursive }, (_eventType, filename) => onEvent(filename === null ? null : filename.toString()));
  }
};
