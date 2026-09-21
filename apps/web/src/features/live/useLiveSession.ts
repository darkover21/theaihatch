import { useEffect, useMemo, useState } from "react";
import { LiveEventSource, MemoryEventSource, PlaybackEngine, type PlaybackSnapshot } from "@theaihatch/playback";
import type { AnySesEvent } from "@theaihatch/ses/browser";
import { validateSesEvent } from "@theaihatch/ses/browser";

export function useLiveSession(workspaceId: string | null, fixture: readonly AnySesEvent[]): { engine: PlaybackEngine; snapshot: PlaybackSnapshot } {
  const engine = useMemo(() => {
    const source = workspaceId === null ? new MemoryEventSource(fixture) : new LiveEventSource();
    return new PlaybackEngine(source);
  }, [fixture, workspaceId]);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(() => engine.getSnapshot());
  useEffect(() => {
    let stopped = false;
    const unsubscribe = engine.subscribe(setSnapshot);
    void engine.load();
    if (workspaceId !== null) {
      const events = new EventSource(`/api/workspaces/${workspaceId}/events`);
      events.addEventListener("ses", (message) => {
        if (stopped) return;
        try { engine.append(validateSesEvent(JSON.parse((message as MessageEvent).data) as unknown)); } catch { void engine.load(); }
      });
      return () => { stopped = true; events.close(); engine.dispose(); unsubscribe(); };
    }
    return () => { stopped = true; engine.dispose(); unsubscribe(); };
  }, [engine, workspaceId]);
  return { engine, snapshot };
}
