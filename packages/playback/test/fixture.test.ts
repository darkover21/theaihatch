import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateSesEvent } from "@theaihatch/ses";
import { PlaybackEngine, MemoryEventSource } from "../src/index.js";

async function fixtureEvents() {
  const contents = await fs.readFile(path.resolve("fixtures/sessions/walking-skeleton/events.jsonl"), "utf8");
  return contents.trim().split("\n").map((line) => validateSesEvent(JSON.parse(line) as unknown));
}

describe("walking skeleton fixture", () => {
  it("REQ-PLY-005 and REQ-SES-006: seeked projection hashes match linear playback at every target", async () => {
    const events = await fixtureEvents();
    const linear = new PlaybackEngine(new MemoryEventSource(events));
    const seeked = new PlaybackEngine(new MemoryEventSource(events));
    await linear.load();
    await seeked.load();
    for (let target = 0; target < events.length; target += 1) {
      await linear.stepEventForward();
      await seeked.seek(target);
      expect(JSON.stringify(seeked.getSnapshot().projection)).toBe(JSON.stringify(linear.getSnapshot().projection));
    }
  });
});
