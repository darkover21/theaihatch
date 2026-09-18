import { createVerify } from "node:crypto";
import { RELEASE_TARGETS, type ReleaseTarget } from "@theaihatch/packaging";
import { z } from "zod";

export interface ReleaseTargetMetadata {
  target: ReleaseTarget;
  url: string;
  sha256: string;
}

export interface ReleaseMetadata {
  schemaVersion: 1;
  version: string;
  url: string;
  targets: readonly ReleaseTargetMetadata[];
  signature: string;
  signedPayload: string;
}

export interface CheckSignedReleaseOptions {
  now?: () => number;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  currentVersion?: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/iu;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const httpsUrl = z.string().url().refine(isHttpsUrl, "must use HTTPS");
const releaseTargetMetadata = z.object({
  target: z.enum(RELEASE_TARGETS),
  url: httpsUrl,
  sha256: z.string().regex(SHA256_HEX),
});
const releaseMetadata = z.object({
  schemaVersion: z.literal(1),
  version: z.string(),
  url: httpsUrl,
  targets: z.array(releaseTargetMetadata).min(1),
  signature: z.string().min(1),
  signedPayload: z.string().min(1),
});

type SignedReleaseFields = Pick<ReleaseMetadata, "schemaVersion" | "version" | "url" | "targets">;

export function canonicalReleasePayload(input: SignedReleaseFields): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    version: input.version,
    url: input.url,
    targets: [...input.targets]
      .sort((left, right) => left.target.localeCompare(right.target))
      .map(({ target, url, sha256 }) => ({ target, url, sha256 })),
  });
}

function strictVersion(value: string): readonly [string, string, string] | null {
  const match = STRICT_VERSION.exec(value);
  return match === null ? null : [match[1]!, match[2]!, match[3]!];
}

function compareVersionPart(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

export function isNewerVersion(currentVersion: string, candidateVersion: string): boolean {
  const current = strictVersion(currentVersion);
  const candidate = strictVersion(candidateVersion);
  if (current === null || candidate === null) return false;

  for (let index = 0; index < current.length; index += 1) {
    const comparison = compareVersionPart(candidate[index]!, current[index]!);
    if (comparison !== 0) return comparison > 0;
  }
  return false;
}

export function verifyReleaseMetadata(metadata: ReleaseMetadata, publicKey: string): boolean {
  try {
    const parsed = releaseMetadata.safeParse(metadata);
    if (!parsed.success || strictVersion(parsed.data.version) === null) return false;

    const signedFields = releaseMetadata.pick({ schemaVersion: true, version: true, url: true, targets: true }).safeParse(JSON.parse(parsed.data.signedPayload));
    if (!signedFields.success) return false;

    const canonicalPayload = canonicalReleasePayload(signedFields.data);
    if (parsed.data.signedPayload !== canonicalPayload) return false;
    if (canonicalPayload !== canonicalReleasePayload(parsed.data)) return false;

    const verifier = createVerify("sha256");
    verifier.update(canonicalPayload);
    verifier.end();
    return verifier.verify(publicKey, parsed.data.signature, "base64");
  } catch {
    return false;
  }
}

export class UpdateChecker {
  private lastCheck: number | null = null;
  private inFlight = false;

  constructor(private readonly minimumIntervalMs = 86_400_000) {}

  shouldCheck(now = Date.now()): boolean {
    return !this.inFlight && (this.lastCheck === null || now - this.lastCheck >= this.minimumIntervalMs);
  }

  markChecked(now = Date.now()): void {
    this.lastCheck = now;
  }

  claim(now = Date.now()): boolean {
    if (!this.shouldCheck(now)) return false;
    this.inFlight = true;
    this.markChecked(now);
    return true;
  }

  release(): void {
    this.inFlight = false;
  }
}

export async function checkSignedRelease(
  url: string,
  publicKey: string,
  checker: UpdateChecker,
  options: CheckSignedReleaseOptions = {},
): Promise<ReleaseMetadata | null> {
  const now = options.now ?? Date.now;
  if (!checker.claim(now())) return null;

  try {
    if (options.currentVersion === undefined) return null;
    if (!isHttpsUrl(url)) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await (options.fetcher ?? fetch)(url, { signal: controller.signal });
      if (!response.ok) return null;

      const parsed = releaseMetadata.safeParse(await response.json());
      if (!parsed.success) return null;
      if (!verifyReleaseMetadata(parsed.data, publicKey)) return null;
      if (!isNewerVersion(options.currentVersion, parsed.data.version)) return null;
      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  } finally {
    checker.release();
  }
}
