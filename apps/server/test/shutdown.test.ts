import { expect, it } from "vitest";
import { createBoundedShutdownHandler } from "../src/bootstrap/shutdown.js";

it("forces process termination when active work misses the shutdown bound", async () => {
  const exitCodes: number[] = [];
  let closeCalls = 0;
  const shutdown = createBoundedShutdownHandler({
    coordinator: {
      async shutdown() {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return false;
      },
    },
    closeServer: async () => { closeCalls += 1; },
    timeoutMs: 20,
    exit: (code) => { exitCodes.push(code); },
  });

  await shutdown();

  expect(exitCodes).toContain(1);
  expect(closeCalls).toBe(1);
});
