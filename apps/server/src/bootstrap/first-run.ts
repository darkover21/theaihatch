import { promises as fs } from "node:fs";
import path from "node:path";
import { userPaths } from "@theaihatch/packaging";
import { initializeStorage } from "./storage.js";

const firstRunSteps = ["directories", "storage", "keychain"] as const;

export type FirstRunStep = (typeof firstRunSteps)[number];

export interface FirstRunState {
  version: 2;
  initialized: boolean;
  dataDirectory: string;
  keychainVerified: boolean;
  completedSteps: readonly FirstRunStep[];
}

export interface FirstRunOptions {
  dataDirectory?: string;
  verifyKeychain?: () => Promise<boolean>;
  initializeStorage?: (dataDirectory: string) => Promise<void>;
}

interface VersionOneState {
  version: 1;
  initialized: true;
  dataDirectory: string;
  keychainVerified: boolean;
}

interface LoadedFirstRunState {
  state: FirstRunState;
  migratedFromVersionOne: boolean;
}

export async function initializeFirstRun(options: FirstRunOptions = {}): Promise<FirstRunState> {
  const dataDirectory = options.dataDirectory ?? userPaths().data;
  const verifyKeychain = options.verifyKeychain ?? (async () => true);
  const storageInitializer = options.initializeStorage ?? initializeStorage;
  const statePath = path.join(dataDirectory, "first-run.json");
  const loadedState = await loadState(statePath, dataDirectory);
  let state = loadedState.state;

  if (loadedState.migratedFromVersionOne) {
    await storageInitializer(dataDirectory);
    state = { ...state, initialized: true, completedSteps: firstRunSteps };
    await writeStateAtomically(statePath, state);
    return state;
  }

  if (!state.completedSteps.includes("directories")) {
    await fs.mkdir(dataDirectory, { recursive: true });
    state = completeStep(state, "directories");
    await writeStateAtomically(statePath, state);
  }

  if (!state.completedSteps.includes("storage")) {
    await storageInitializer(dataDirectory);
    state = completeStep(state, "storage");
    await writeStateAtomically(statePath, state);
  }

  if (!state.completedSteps.includes("keychain")) {
    state = completeStep(state, "keychain", await verifyKeychain());
    await writeStateAtomically(statePath, state);
  }

  return state;
}

async function loadState(statePath: string, dataDirectory: string): Promise<LoadedFirstRunState> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (isVersionTwoState(parsed) && parsed.dataDirectory === dataDirectory) return { state: parsed, migratedFromVersionOne: false };
    if (isVersionOneState(parsed) && parsed.dataDirectory === dataDirectory) {
      return {
        state: {
          version: 2,
          initialized: false,
          dataDirectory,
          keychainVerified: parsed.keychainVerified,
          completedSteps: ["directories"]
        },
        migratedFromVersionOne: true
      };
    }
  } catch {
    // An absent or malformed final state is retried from the first checkpoint.
  }

  return {
    state: {
      version: 2,
      initialized: false,
      dataDirectory,
      keychainVerified: false,
      completedSteps: []
    },
    migratedFromVersionOne: false
  };
}

function completeStep(state: FirstRunState, completedStep: FirstRunStep, keychainVerified = state.keychainVerified): FirstRunState {
  const completedSteps = firstRunSteps.filter((step) => state.completedSteps.includes(step) || step === completedStep);
  return {
    ...state,
    initialized: completedSteps.length === firstRunSteps.length,
    keychainVerified,
    completedSteps
  };
}

async function writeStateAtomically(statePath: string, state: FirstRunState): Promise<void> {
  const temporaryStatePath = `${statePath}.tmp`;
  const file = await fs.open(temporaryStatePath, "w");
  try {
    await file.writeFile(JSON.stringify(state, null, 2), "utf8");
  } finally {
    await file.close();
  }
  await fs.rename(temporaryStatePath, statePath);
}

function isVersionTwoState(value: unknown): value is FirstRunState {
  if (!isRecord(value) || value.version !== 2 || typeof value.initialized !== "boolean" || typeof value.dataDirectory !== "string" || typeof value.keychainVerified !== "boolean" || !isCompletedSteps(value.completedSteps)) return false;
  return value.initialized === (value.completedSteps.length === firstRunSteps.length);
}

function isVersionOneState(value: unknown): value is VersionOneState {
  return isRecord(value) && value.version === 1 && value.initialized === true && typeof value.dataDirectory === "string" && typeof value.keychainVerified === "boolean";
}

function isCompletedSteps(value: unknown): value is FirstRunStep[] {
  if (!Array.isArray(value) || !value.every(isFirstRunStep)) return false;
  return firstRunSteps.slice(0, value.length).every((step, index) => value[index] === step);
}

function isFirstRunStep(value: unknown): value is FirstRunStep {
  return typeof value === "string" && firstRunSteps.includes(value as FirstRunStep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
