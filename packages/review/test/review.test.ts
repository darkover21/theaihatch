import { describe, expect, it } from "vitest";
import { applyHunk } from "../src/apply.js";
import { diffFile } from "../src/diff.js";

describe("review", () => {
  it("REQ-REV-001 and REQ-REV-002: computes and independently applies a hunk", () => { const diff = diffFile("a.ts", "one\ntwo\nthree", "one\nTWO\nthree"); const hunk = diff.hunks[0]; if (hunk === undefined) throw new Error("missing hunk"); const result = applyHunk(diff.before, hunk, { hunkId: hunk.id, decision: "accepted", actor: "local", at: "now" }); expect(result.content).toBe(diff.after); });
  it("REQ-REV-002: stale fingerprints fail safely", () => { const diff = diffFile("a.ts", "one", "two"); const hunk = diff.hunks[0]; if (hunk === undefined) throw new Error("missing hunk"); expect(() => applyHunk("changed", hunk, { hunkId: hunk.id, decision: "accepted", actor: "local", at: "now" })).toThrow(/stale/); });
});
