import { createVerify } from "node:crypto";
import { z } from "zod";
export interface ReleaseMetadata { version: string; url: string; signature: string; signedPayload: string; }
const releaseMetadata = z.object({ version: z.string().min(1), url: z.string().url(), signature: z.string().min(1), signedPayload: z.string().min(1) });
export function verifyReleaseMetadata(metadata: ReleaseMetadata, publicKey: string): boolean { const verifier = createVerify("sha256"); verifier.update(metadata.signedPayload); verifier.end(); return verifier.verify(publicKey, metadata.signature, "base64"); }
export class UpdateChecker { private lastCheck = 0; constructor(private readonly minimumIntervalMs = 86_400_000) {} shouldCheck(now = Date.now()): boolean { return now - this.lastCheck >= this.minimumIntervalMs; } markChecked(now = Date.now()): void { this.lastCheck = now; } }
export async function checkSignedRelease(url: string, publicKey: string, checker: UpdateChecker, fetcher: typeof fetch = fetch): Promise<ReleaseMetadata | null> { if (!checker.shouldCheck()) return null; try { const response = await fetcher(url); if (!response.ok) return null; const metadata = releaseMetadata.parse(await response.json()); if (!verifyReleaseMetadata(metadata, publicKey)) return null; checker.markChecked(); return metadata; } catch { return null; } }
