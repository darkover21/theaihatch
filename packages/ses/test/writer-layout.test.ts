import { describe, expect, it } from "vitest";
import { sessionDirectory } from "../src/index.js";

describe("session layout", () => {
  it("REQ-SES-009: resolves valid sessions below data-dir and rejects traversal", () => {
    expect(sessionDirectory("data", "demo")).toMatch(/sessions[\\/]demo$/u);
    expect(() => sessionDirectory("data", "../escape")).toThrow();
  });
});
