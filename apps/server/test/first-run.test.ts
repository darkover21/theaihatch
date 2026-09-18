import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeFirstRun, type FirstRunState } from "../src/bootstrap/first-run.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function fixtureDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-first-run-"));
  temporaryDirectories.push(directory);
  return directory;
}

function statePath(directory: string): string {
  return path.join(directory, "first-run.json");
}

async function readState(directory: string): Promise<FirstRunState> {
  return JSON.parse(await fs.readFile(statePath(directory), "utf8")) as FirstRunState;
}

describe("first-run initialization", () => {
  it("initializes directories, storage, and keychain on a fresh run", async () => {
    const directory = await fixtureDirectory();
    const storageDirectories: string[] = [];
    let keychainChecks = 0;

    const state = await initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async (dataDirectory) => { storageDirectories.push(dataDirectory); },
      verifyKeychain: async () => { keychainChecks += 1; return false; }
    });

    expect(storageDirectories).toEqual([directory]);
    expect(keychainChecks).toBe(1);
    expect(state).toEqual({
      version: 2,
      initialized: true,
      dataDirectory: directory,
      keychainVerified: false,
      completedSteps: ["directories", "storage", "keychain"]
    });
    await expect(readState(directory)).resolves.toEqual(state);
  });

  it("does not invoke completed injected steps on a second run", async () => {
    const directory = await fixtureDirectory();
    const first = await initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async () => undefined,
      verifyKeychain: async () => true
    });

    await expect(initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async () => { throw new Error("storage should not rerun"); },
      verifyKeychain: async () => { throw new Error("keychain should not rerun"); }
    })).resolves.toEqual(first);
  });

  it("persists a complete directory checkpoint when storage initialization fails", async () => {
    const directory = await fixtureDirectory();
    let keychainChecks = 0;

    await expect(initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async () => { throw new Error("storage unavailable"); },
      verifyKeychain: async () => { keychainChecks += 1; return true; }
    })).rejects.toThrow("storage unavailable");

    expect(keychainChecks).toBe(0);
    await expect(readState(directory)).resolves.toEqual({
      version: 2,
      initialized: false,
      dataDirectory: directory,
      keychainVerified: false,
      completedSteps: ["directories"]
    });
  });

  it("REQ-PKG-002: resumes after storage initialization fails", async () => {
    const directory = await fixtureDirectory();
    let attempts = 0;

    await expect(initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async () => { attempts += 1; throw new Error("storage unavailable"); }
    })).rejects.toThrow("storage unavailable");
    await initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async () => { attempts += 1; }
    });

    expect(attempts).toBe(2);
    await expect(readState(directory)).resolves.toMatchObject({ version: 2, initialized: true });
  });

  it("replaces a malformed final state with a complete fresh state", async () => {
    const directory = await fixtureDirectory();
    await fs.writeFile(statePath(directory), '{"version":2', "utf8");

    const state = await initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async () => undefined,
      verifyKeychain: async () => true
    });

    await expect(readState(directory)).resolves.toEqual(state);
    expect(state.completedSteps).toEqual(["directories", "storage", "keychain"]);
  });

  it("does not treat a temporary state file as initialized", async () => {
    const directory = await fixtureDirectory();
    await fs.writeFile(path.join(directory, "first-run.json.tmp"), JSON.stringify({
      version: 2,
      initialized: true,
      dataDirectory: directory,
      keychainVerified: true,
      completedSteps: ["directories", "storage", "keychain"]
    }), "utf8");
    let storageCalls = 0;
    let keychainChecks = 0;

    await initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async () => { storageCalls += 1; },
      verifyKeychain: async () => { keychainChecks += 1; return true; }
    });

    expect(storageCalls).toBe(1);
    expect(keychainChecks).toBe(1);
  });

  it("restarts when a state skips storage before keychain", async () => {
    const directory = await fixtureDirectory();
    await fs.writeFile(statePath(directory), JSON.stringify({
      version: 2,
      initialized: false,
      dataDirectory: directory,
      keychainVerified: true,
      completedSteps: ["directories", "keychain"]
    }), "utf8");
    let storageCalls = 0;
    let keychainChecks = 0;

    const state = await initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async () => { storageCalls += 1; },
      verifyKeychain: async () => { keychainChecks += 1; return false; }
    });

    expect(storageCalls).toBe(1);
    expect(keychainChecks).toBe(1);
    expect(state).toMatchObject({ keychainVerified: false, completedSteps: ["directories", "storage", "keychain"] });
  });

  it("migrates a valid version-1 state and runs only the new storage step", async () => {
    const directory = await fixtureDirectory();
    await fs.writeFile(statePath(directory), JSON.stringify({
      version: 1,
      initialized: true,
      dataDirectory: directory,
      keychainVerified: false
    }), "utf8");
    let storageCalls = 0;

    const state = await initializeFirstRun({
      dataDirectory: directory,
      initializeStorage: async () => { storageCalls += 1; },
      verifyKeychain: async () => { throw new Error("keychain should not rerun"); }
    });

    expect(storageCalls).toBe(1);
    expect(state).toEqual({
      version: 2,
      initialized: true,
      dataDirectory: directory,
      keychainVerified: false,
      completedSteps: ["directories", "storage", "keychain"]
    });
  });
});
