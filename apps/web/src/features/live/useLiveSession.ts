import { useCallback, useEffect, useMemo, useState } from "react";
import { LiveEventSource, MemoryEventSource, PlaybackEngine, type PlaybackSnapshot } from "@theaihatch/playback";
import type { AnySesEvent } from "@theaihatch/ses/browser";
import { validateSesEvent } from "@theaihatch/ses/browser";

export type LiveConnection = "idle" | "connecting" | "live" | "reconnecting" | "lost";

export function useLiveSession(workspaceId: string | null, fixture: readonly AnySesEvent[]): { engine: PlaybackEngine; snapshot: PlaybackSnapshot; connection: LiveConnection } {
  const session = useMemo(() => {
    const source = workspaceId === null ? new MemoryEventSource(fixture) : new LiveEventSource();
    return { source, engine: new PlaybackEngine(source) };
  }, [fixture, workspaceId]);
  const { source, engine } = session;
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(() => engine.getSnapshot());
  const [generation, setGeneration] = useState(0);
  const [connection, setConnection] = useState<LiveConnection>("idle");
  const resync = useCallback(() => setGeneration((current) => current + 1), []);

  useEffect(() => {
    let stopped = false;
    const unsubscribe = engine.subscribe(setSnapshot);
    void engine.load();
    if (workspaceId === null) { setConnection("idle"); return () => { stopped = true; engine.dispose(); unsubscribe(); }; }
    setConnection("connecting");

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
    events.addEventListener("hello", () => { if (!stopped) setConnection("live"); });
    events.addEventListener("ses", (message) => {
      if (stopped || reconnecting) return;
      setConnection("live");
      try {
        engine.append(validateSesEvent(JSON.parse((message as MessageEvent).data) as unknown));
      } catch {
        restart();
      }
    });
    events.addEventListener("overflow", restart);
    // A non-2xx response (a stale workspace id after a server restart, say) closes an EventSource for
    // good rather than retrying, so without this the page just stops updating with nothing on screen to
    // say why. CONNECTING means the browser is still retrying on its own and will recover by itself.
    events.addEventListener("error", () => {
      if (stopped || reconnecting) return;
      setConnection(events.readyState === EventSource.CLOSED ? "lost" : "reconnecting");
    });
    return () => { stopped = true; events.close(); engine.dispose(); unsubscribe(); };
  }, [engine, resync, source, workspaceId, generation]);

  return { engine, snapshot, connection };
}
