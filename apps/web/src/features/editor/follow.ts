import type * as Monaco from "monaco-editor";

export interface Caret {
  path: string;
  position: { line: number; column: number };
}

/**
 * Keeps the edit being animated on screen.
 *
 * Monaco's revealLineInCenterIfOutsideViewport already has the hysteresis the safe-zone requirement asks
 * for — it acts only when the line has left the viewport — and brings its own smooth scrolling, in one
 * call and with no conversion between lines and pixels. typing-sim's scrollTarget expresses the same idea
 * in lines and is the finer-grained alternative if centring ever reads as jumpy; swapping it in means
 * changing this function and nothing else.
 *
 * Seeking is not typing: a restore should land on the recorded position immediately rather than gliding
 * to it, so it scrolls without animation and centres unconditionally.
 */
export function revealCaret(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  caret: Caret,
  mode: "smooth" | "instant"
): void {
  const lineNumber = caret.position.line + 1;
  const column = caret.position.column + 1;
  // Placing the position costs nothing while the editor is read-only and unfocused, and it makes
  // renderLineHighlight mark the line being edited, which is visible without stealing focus.
  editor.setPosition({ lineNumber, column });
  if (mode === "instant") editor.revealLineInCenter(lineNumber, monaco.editor.ScrollType.Immediate);
  else editor.revealLineInCenterIfOutsideViewport(lineNumber, monaco.editor.ScrollType.Smooth);
}

/**
 * Monaco hides its own cursor when the editor is blurred, and focusing it on every typed character would
 * steal focus from the page, so the caret is drawn as a decoration instead. The range is empty and the
 * marker is attached with beforeContentClassName, which still renders at the end of a line and on an
 * empty one where a zero-width range would show nothing.
 */
export function caretDecoration(monaco: typeof Monaco, caret: Caret): Monaco.editor.IModelDeltaDecoration {
  const lineNumber = caret.position.line + 1;
  const column = caret.position.column + 1;
  return {
    range: new monaco.Range(lineNumber, column, lineNumber, column),
    options: { beforeContentClassName: "ses-caret", stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
  };
}
