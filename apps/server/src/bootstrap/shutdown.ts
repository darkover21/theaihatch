export interface ShutdownCoordinator {
  shutdown(timeoutMs: number): Promise<boolean>;
}

export interface BoundedShutdownOptions {
  coordinator: ShutdownCoordinator;
  closeServer: () => Promise<void>;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

export function createBoundedShutdownHandler(options: BoundedShutdownOptions): () => Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shutdown: Promise<void> | undefined;

  return () => {
    if (shutdown !== undefined) return shutdown;
    shutdown = (async () => {
      let forced = false;
      const forceTimer = setTimeout(() => {
        forced = true;
        exit(1);
      }, timeoutMs);
      forceTimer.unref?.();
      try {
        const drained = await options.coordinator.shutdown(Math.max(0, timeoutMs - 500));
        await options.closeServer();
        if (!drained && !forced) {
          forced = true;
          exit(1);
        }
      } catch (error) {
        console.error(error);
        forced = true;
        exit(1);
      } finally {
        if (!forced) clearTimeout(forceTimer);
      }
    })();
    return shutdown;
  };
}
