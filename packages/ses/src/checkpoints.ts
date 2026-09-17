import type { AnySesEvent, Position, SesEvent, WorkspacePath } from "./schema.js";

export interface FileProjectionState {
  files: Map<WorkspacePath, string | null>;
  touched: Set<WorkspacePath>;
}

export function createFileProjection(): FileProjectionState {
  return { files: new Map(), touched: new Set() };
}

export function cloneFileProjection(source: FileProjectionState): FileProjectionState {
  return { files: new Map(source.files), touched: new Set(source.touched) };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function positionToOffset(text: string, position: Position): number {
  const starts = lineStarts(text);
  const start = starts[position.line];
  if (start === undefined) throw new Error(`line ${position.line} is outside the document`);
  const nextStart = starts[position.line + 1];
  const end = nextStart === undefined ? text.length : nextStart - 1;
  if (position.column > end - start) throw new Error(`column ${position.column} is outside the document`);
  return start + position.column;
}

export function offsetToPosition(text: string, offset: number): Position {
  if (offset < 0 || offset > text.length) throw new Error(`offset ${offset} is outside the document`);
  const starts = lineStarts(text);
  let line = 0;
  for (let index = 1; index < starts.length; index += 1) {
    const start = starts[index];
    if (start === undefined || start > offset) break;
    line = index;
  }
  const lineStart = starts[line] ?? 0;
  return { line, column: offset - lineStart };
}

function fileContent(state: FileProjectionState, path: WorkspacePath): string {
  const content = state.files.get(path);
  if (content === undefined || content === null) throw new Error(`file is not present: ${path}`);
  return content;
}

function markTouched(state: FileProjectionState, path: WorkspacePath): void {
  state.touched.add(path);
}

export function applyFileEvent(state: FileProjectionState, event: AnySesEvent): void {
  switch (event.type) {
    case "file_create":
      state.files.set(event.payload.path, "");
      markTouched(state, event.payload.path);
      return;
    case "file_delete":
      if (!state.files.has(event.payload.path)) throw new Error(`cannot delete missing file: ${event.payload.path}`);
      state.files.set(event.payload.path, null);
      markTouched(state, event.payload.path);
      return;
    case "file_rename": {
      const content = fileContent(state, event.payload.from);
      state.files.delete(event.payload.from);
      state.files.set(event.payload.to, content);
      markTouched(state, event.payload.from);
      markTouched(state, event.payload.to);
      return;
    }
    case "edit_insert": {
      const content = fileContent(state, event.payload.path);
      const offset = positionToOffset(content, event.payload.position);
      state.files.set(event.payload.path, content.slice(0, offset) + event.payload.text + content.slice(offset));
      markTouched(state, event.payload.path);
      return;
    }
    case "edit_delete": {
      const content = fileContent(state, event.payload.path);
      const start = positionToOffset(content, event.payload.range.start);
      const end = positionToOffset(content, event.payload.range.end);
      const actual = content.slice(start, end);
      if (actual !== event.payload.deletedText) throw new Error(`delete delta does not match ${event.payload.path}`);
      state.files.set(event.payload.path, content.slice(0, start) + content.slice(end));
      markTouched(state, event.payload.path);
      return;
    }
    case "edit_replace": {
      const content = fileContent(state, event.payload.path);
      const start = positionToOffset(content, event.payload.range.start);
      const end = positionToOffset(content, event.payload.range.end);
      const actual = content.slice(start, end);
      if (actual !== event.payload.deletedText) throw new Error(`replace delta does not match ${event.payload.path}`);
      state.files.set(event.payload.path, content.slice(0, start) + event.payload.insertedText + content.slice(end));
      markTouched(state, event.payload.path);
      return;
    }
    case "checkpoint":
      for (const file of event.payload.files) {
        state.files.set(file.path, file.content);
        state.touched.add(file.path);
      }
      return;
    default:
      return;
  }
}

export function checkpointFiles(state: FileProjectionState): SesEvent<"checkpoint">["payload"]["files"] {
  return [...state.touched]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => {
      const content = state.files.get(path) ?? null;
      return {
        path,
        content,
        contentHash: content === null ? null : contentHash(content)
      };
    });
}

function contentHash(content: string): string {
  let first = 2166136261;
  let second = 16777619;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ ((code << 8) | (code >>> 8)), 2246822519);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
