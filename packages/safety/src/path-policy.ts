import { promises as fs } from "node:fs";
import path from "node:path";

export class PathPolicyError extends Error { constructor(message: string) { super(message); this.name = "PathPolicyError"; } }
function inside(root: string, candidate: string): boolean { const left = process.platform === "win32" ? root.toLocaleLowerCase() : root; const right = process.platform === "win32" ? candidate.toLocaleLowerCase() : candidate; const relative = path.relative(left, right); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
async function canonicalParent(candidate: string): Promise<string> { const parent = path.dirname(candidate); try { return await fs.realpath(parent); } catch { return parent; } }

export interface PathPolicy { root: string; resolve(candidate: string): Promise<string>; assert(candidate: string): Promise<void>; }
export async function createPathPolicy(rootCandidate: string): Promise<PathPolicy> {
  const root = await fs.realpath(rootCandidate);
  const resolve = async (candidate: string): Promise<string> => {
    if (candidate.includes("\u0000")) throw new PathPolicyError("path contains NUL");
    const absolute = path.resolve(root, candidate);
    if (!inside(root, absolute)) throw new PathPolicyError("path is outside workspace root");
    const existing = await fs.realpath(absolute).catch(async () => canonicalParent(absolute));
    if (!inside(root, existing)) throw new PathPolicyError("path resolves outside workspace root");
    return absolute;
  };
  return { root, resolve, assert: async (candidate) => { await resolve(candidate); } };
}
