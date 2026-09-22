import { useCallback, useEffect, useMemo, useState } from "react";
import { LiveEventSource, MemoryEventSource, PlaybackEngine, type PlaybackSnapshot } from "@theaihatch/playback";
import type { AnySesEvent } from "@theaihatch/ses/browser";
import { validateSesEvent } from "@theaihatch/ses/browser";

export function useLiveSession(workspaceId: string | null, fixture: readonly AnySesEvent[]): { engine: PlaybackEngine; snapshot: PlaybackSnapshot } {
  const session = useMemo(() => {
    const source = workspaceId === null ? new MemoryEventSource(fixture) : new LiveEventSource();
    return { source, engine: new PlaybackEngine(source) };
  }, [fixture, workspaceId]);
  const { source, engine } = session;
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(() => engine.getSnapshot());
  const [generation, setGeneration] = useState(0);
  const resync = useCallback(() => setGeneration((current) => current + 1), []);

  useEffect(() => {
    let stopped = false;
    const unsubscribe = engine.subscribe(setSnapshot);
    void engine.load();
    if (workspaceId === null) return () => { stopped = true; engine.dispose(); unsubscribe(); };

    // A reset empties the source, so it expects seq 0 again. The browser would otherwise reconnect this
    // same EventSource with Last-Event-ID and resume mid-stream, leaving every later event non-contiguous
    // and looping the reset. Tearing the connection down and bumping the generation forces a fresh
    // subscription from 0, and the once flag keeps a burst of bad frames to a single reconnect.
    let reconnecting = false;
    const events = new EventSource(`/api/workspaces/${workspaceId}/events`);
    const restart = (): void => {
      if (stopped || reconnecting) return;
      reconnecting = true;
      events.close();
      if (source instanceof LiveEventSource) source.reset();
      resync();
    };
    events.addEventListener("ses", (message) => {
      if (stopped || reconnecting) return;
      try {
        engine.append(validateSesEvent(JSON.parse((message as MessageEvent).data) as unknown));
      } catch {
        restart();
      }
    });
    events.addEventListener("overflow", restart);
    return () => { stopped = true; events.close(); engine.dispose(); unsubscribe(); };
  }, [engine, resync, source, workspaceId, generation]);

  return { engine, snapshot };
}
