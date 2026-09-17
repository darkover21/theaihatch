import type { AnySesEvent, StepOutcome } from "@theaihatch/ses/browser";

export interface PlaybackStep {
  id: string;
  label: string;
  startSeq: number;
  endSeq: number;
  outcome: StepOutcome | "running";
  files: string[];
}

export function conciseLabel(label: string, fallback: string): string {
  const value = label.trim() || fallback;
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}

function eventPaths(event: AnySesEvent): string[] {
  if ("path" in event.payload) return [event.payload.path];
  if (event.type === "file_rename") return [event.payload.from, event.payload.to];
  return [];
}

export function buildStepIndex(events: readonly AnySesEvent[]): PlaybackStep[] {
  const steps: PlaybackStep[] = [];
  const open = new Map<string, PlaybackStep>();
  for (const event of events) {
    if (event.type === "step_begin") {
      const step: PlaybackStep = {
        id: event.payload.stepId,
        label: conciseLabel(event.payload.label, "Run step"),
        startSeq: event.seq,
        endSeq: event.seq,
        outcome: "running",
        files: event.payload.primaryPath === undefined ? [] : [event.payload.primaryPath]
      };
      steps.push(step);
      open.set(step.id, step);
      continue;
    }
    if (event.type === "step_end") {
      const step = open.get(event.payload.stepId);
      if (step !== undefined) {
        step.endSeq = event.seq;
        step.outcome = event.payload.outcome;
        open.delete(event.payload.stepId);
      }
      continue;
    }
    if (open.size > 0) {
      const paths = eventPaths(event);
      for (const step of open.values()) for (const file of paths) if (!step.files.includes(file)) step.files.push(file);
      for (const step of open.values()) step.endSeq = Math.max(step.endSeq, event.seq);
    }
  }
  for (const step of open.values()) step.endSeq = events.at(-1)?.seq ?? step.startSeq;
  if (steps.length > 0) return steps.sort((left, right) => left.startSeq - right.startSeq);
  return inferSteps(events);
}

function inferSteps(events: readonly AnySesEvent[]): PlaybackStep[] {
  const steps: PlaybackStep[] = [];
  let current: PlaybackStep | null = null;
  for (const event of events) {
    const paths = eventPaths(event);
    const key = paths[0] ?? (event.type === "terminal_command" || event.type === "terminal_output" ? "terminal" : event.type);
    if (current === null || current.files[0] !== key) {
      current = { id: `inferred-${steps.length}`, label: conciseLabel(`Work on ${key}`, "Work"), startSeq: event.seq, endSeq: event.seq, outcome: "succeeded", files: paths };
      steps.push(current);
    } else {
      current.endSeq = event.seq;
    }
  }
  return steps;
}
