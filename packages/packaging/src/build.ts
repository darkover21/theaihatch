import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
export type ReleaseTarget = "windows-x64" | "macos-arm64" | "linux-x64";
export interface ArtifactManifest { target: ReleaseTarget; executable: string; embeddedWebDirectory: string; checksum: string; }
export async function createArtifactManifest(target: ReleaseTarget, executable: string, webDirectory: string): Promise<ArtifactManifest> { const bytes = await fs.readFile(executable); return { target, executable: path.basename(executable), embeddedWebDirectory: path.resolve(webDirectory), checksum: createHash("sha256").update(bytes).digest("hex") }; }
export function seaBuildPlan(target: ReleaseTarget): { target: ReleaseTarget; mode: "node-sea"; assets: string[] } { return { target, mode: "node-sea", assets: ["apps/web/dist", "apps/server/src"] }; }
export async function writeSeaConfig(output: string, entrypoint: string, assets: Record<string, string>): Promise<void> { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify({ main: path.resolve(entrypoint), output: path.resolve(`${output}.blob`), disableExperimentalSEAWarning: true, assets: Object.fromEntries(Object.entries(assets).map(([key, value]) => [key, path.resolve(value)])) }, null, 2), "utf8"); }
