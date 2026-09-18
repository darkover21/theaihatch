import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPackage, buildPlan } from "./sea.js";
import { RELEASE_TARGETS, type ReleaseTarget } from "./build.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const target = command === "build" ? process.env.THEAIHATCH_TARGET : option("--target");
  if (!RELEASE_TARGETS.includes(target as ReleaseTarget)) throw new Error(`Unsupported or missing target: ${target ?? "(none)"}; build requires THEAIHATCH_TARGET`);
  const releaseVersion = option("--version") ?? process.env.THEAIHATCH_VERSION ?? "0.1.0";
  if (command === "plan") console.log(JSON.stringify(await buildPlan(target as ReleaseTarget, releaseVersion, projectRoot), null, 2));
  else if (command === "build") console.log(JSON.stringify(await buildPackage({
    projectRoot, target: target as ReleaseTarget, releaseVersion,
    outputDirectory: process.env.THEAIHATCH_OUTPUT ?? path.join(projectRoot, "dist", "packages"),
  }), null, 2));
  else throw new Error("Usage: package:plan -- --target TARGET --version VERSION | package:build");
}

void main().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
