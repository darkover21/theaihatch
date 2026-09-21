import type { AnySesEvent, Position, TextRange } from "@theaihatch/ses/browser";
import { applyFileEvent, type FileProjectionState } from "@theaihatch/ses/browser";

export interface ProjectionState {
  files: Record<string, string>;
  openPaths: string[];
  activePath: string | null;
  cursors: Record<string, Position>;
  selections: Record<string, TextRange[]>;
  scroll: Record<string, { scrollTop: number; scrollLeft: number }>;
  diffMarkers: Array<{ path: string; range: TextRange; kind: "added" | "modified" | "deleted"; hunkId: string }>;
  terminal: string;
}

export function emptyProjection(): ProjectionState {
  return { files: {}, openPaths: [], activePath: null, cursors: {}, selections: {}, scroll: {}, diffMarkers: [], terminal: "" };
}

export function cloneProjection(source: ProjectionState): ProjectionState {
  return {
    files: { ...source.files },
    openPaths: [...source.openPaths],
    activePath: source.activePath,
    cursors: Object.fromEntries(Object.entries(source.cursors).map(([path, position]) => [path, { ...position }])),
    selections: Object.fromEntries(Object.entries(source.selections).map(([path, ranges]) => [path, ranges.map((range) => ({ start: { ...range.start }, end: { ...range.end } }))])),
    scroll: Object.fromEntries(Object.entries(source.scroll).map(([path, value]) => [path, { ...value }])),
    diffMarkers: source.diffMarkers.map((marker) => ({ ...marker, range: { start: { ...marker.range.start }, end: { ...marker.range.end } } })),
    terminal: source.terminal
  };
}

function applyFileDelta(projection: ProjectionState, event: AnySesEvent): void {
  const state: FileProjectionState = {
    files: new Map(Object.entries(projection.files)),
    touched: new Set(Object.keys(projection.files))
  };
  applyFileEvent(state, event);
  projection.files = Object.fromEntries([...state.files].flatMap(([path, content]) => content === null ? [] : [[path, content]]));
}

function requireFile(projection: ProjectionState, path: string): string {
  const content = projection.files[path];
  if (content === undefined) throw new Error(`file is not present: ${path}`);
  return content;
}

export function restoreCheckpoint(projection: ProjectionState, event: AnySesEvent): void {
  if (event.type !== "checkpoint") throw new Error("restore requires a checkpoint event");
  projection.files = Object.fromEntries(event.payload.files.flatMap((file) => file.content === null ? [] : [[file.path, file.content]]));
  projection.openPaths = event.payload.files.filter((file) => file.content !== null).map((file) => file.path);
  projection.activePath = projection.openPaths.at(-1) ?? null;
  projection.cursors = {};
  projection.selections = {};
  projection.scroll = {};
}

export function restoreCheckpointFiles(projection: ProjectionState, event: AnySesEvent): void {
  if (event.type !== "checkpoint") throw new Error("restore requires a checkpoint event");
  projection.files = Object.fromEntries(event.payload.files.flatMap((file) => file.content === null ? [] : [[file.path, file.content]]));
  projection.openPaths = projection.openPaths.filter((path) => projection.files[path] !== undefined);
  if (projection.activePath !== null && projection.files[projection.activePath] === undefined) projection.activePath = projection.openPaths.at(-1) ?? null;
}

export function applyProjectionEvent(projection: ProjectionState, event: AnySesEvent): void {
  switch (event.type) {
    case "file_create":
      applyFileDelta(projection, event);
      return;
    case "file_delete":
      applyFileDelta(projection, event);
      projection.openPaths = projection.openPaths.filter((path) => path !== event.payload.path);
      if (projection.activePath === event.payload.path) projection.activePath = projection.openPaths.at(-1) ?? null;
      return;
    case "file_rename": {
      applyFileDelta(projection, event);
      projection.openPaths = projection.openPaths.map((path) => path === event.payload.from ? event.payload.to : path);
      if (projection.activePath === event.payload.from) projection.activePath = event.payload.to;
      return;
    }
    case "file_open":
      requireFile(projection, event.payload.path);
      if (!projection.openPaths.includes(event.payload.path)) projection.openPaths.push(event.payload.path);
      projection.activePath = event.payload.path;
      return;
    case "file_close":
      projection.openPaths = projection.openPaths.filter((path) => path !== event.payload.path);
      if (projection.activePath === event.payload.path) projection.activePath = projection.openPaths.at(-1) ?? null;
      return;
    case "tab_focus":
      if (!projection.openPaths.includes(event.payload.path)) throw new Error(`tab is not open: ${event.payload.path}`);
      projection.activePath = event.payload.path;
      return;
    case "cursor_move":
      requireFile(projection, event.payload.path);
      if (!projection.openPaths.includes(event.payload.path)) throw new Error(`tab is not open: ${event.payload.path}`);
      projection.cursors[event.payload.path] = { ...event.payload.position };
      return;
    case "selection_change":
      requireFile(projection, event.payload.path);
      projection.selections[event.payload.path] = event.payload.selections.map((range) => ({ start: { ...range.start }, end: { ...range.end } }));
      return;
    case "scroll":
      requireFile(projection, event.payload.path);
      projection.scroll[event.payload.path] = { scrollTop: event.payload.scrollTop, scrollLeft: event.payload.scrollLeft };
      return;
    case "edit_insert":
    case "edit_delete":
    case "edit_replace":
      applyFileDelta(projection, event);
      return;
    case "file_save":
      requireFile(projection, event.payload.path);
      return;
    case "checkpoint":
      restoreCheckpointFiles(projection, event);
      return;
    case "diff_marker":
      projection.diffMarkers.push({ path: event.payload.path, range: event.payload.range, kind: event.payload.kind, hunkId: event.payload.hunkId });
      return;
    case "terminal_output":
      projection.terminal += event.payload.chunk;
      return;
    case "terminal_command":
      projection.terminal += `$ ${event.payload.command}\n`;
      return;
    default:
      return;
  }
}
