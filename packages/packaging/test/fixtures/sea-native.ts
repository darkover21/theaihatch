import { loadNativePackage } from "../../src/runtime.js";

// Exercise the real wrappers and native bindings, without touching user credentials.
const failures: string[] = [];
let answer: unknown;
let keytarLoaded = false;
try {
  const Database = loadNativePackage("better-sqlite3");
  const database = new Database(":memory:");
  try { answer = database.prepare<[], { answer: number }>("SELECT 42 AS answer").get()?.answer; }
  finally { database.close(); }
} catch (error) { failures.push(`better-sqlite3: ${(error as Error).stack}`); }
try {
  const keytar = loadNativePackage("keytar");
  if (typeof keytar.getPassword !== "function") throw new Error("keytar wrapper missing getPassword");
  keytarLoaded = true;
} catch (error) { failures.push(`keytar: ${(error as Error).stack}`); }
console.log(JSON.stringify({ answer, keytar: keytarLoaded }));
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
