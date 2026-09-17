import { describe, expect, it } from "vitest";
import { decorateGitStatus, parsePorcelainZ } from "../src/git-status.js";

describe("git status", () => {
  it("REQ-WKS-004: parses statuses and decorates ancestor folders", () => {
    const entries = parsePorcelainZ(" M src/changed.ts\u0000?? new.ts\u0000R  src/renamed.ts\u0000src/old.ts\u0000UU conflict.ts\u0000");
    expect(entries.map((entry) => entry.kind)).toEqual(["modified", "untracked", "renamed", "conflicted"]);
    const decorations = decorateGitStatus(entries);
    expect(decorations.get("src")).toBe("renamed");
    expect(decorations.get("conflict.ts")).toBe("conflicted");
  });
});
