import { describe, expect, it } from "vitest";
import { seaBuildPlan } from "../src/build.js";
import { userPaths } from "../src/paths.js";
describe("packaging", () => { it("REQ-PKG-001: has a SEA plan for every supported target", () => { expect(["windows-x64", "macos-arm64", "linux-x64"].map((target) => seaBuildPlan(target as "windows-x64" | "macos-arm64" | "linux-x64").mode)).toEqual(["node-sea", "node-sea", "node-sea"]); }); it("REQ-PKG-005: resolves platform data locations", () => { expect(userPaths("win32", "C:\\Users\\demo").data).toContain("AppData"); expect(userPaths("darwin", "/Users/demo").config).toContain("Library"); expect(userPaths("linux", "/home/demo").config).toContain(".config"); }); });
