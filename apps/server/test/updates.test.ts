import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalReleasePayload,
  checkSignedRelease,
  isNewerVersion,
  type ReleaseMetadata,
  UpdateChecker,
  verifyReleaseMetadata,
} from "../src/updates/check.js";

const targets: ReleaseMetadata["targets"] = [
  {
    target: "windows-x64",
    url: "https://updates.test/theaihatch-0.2.0-windows-x64.exe",
    sha256: "a".repeat(64),
  },
  {
    target: "linux-x64",
    url: "https://updates.test/theaihatch-0.2.0-linux-x64",
    sha256: "b".repeat(64),
  },
];

let publicKey: string;
let privateKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  publicKey = String(pair.publicKey.export({ type: "pkcs1", format: "pem" }));
  privateKey = String(pair.privateKey.export({ type: "pkcs1", format: "pem" }));
});

function signRelease(overrides: Partial<Pick<ReleaseMetadata, "version" | "url" | "targets">> = {}): ReleaseMetadata {
  const unsigned = {
    schemaVersion: 1 as const,
    version: overrides.version ?? "0.2.0",
    url: overrides.url ?? "https://updates.test/release.json",
    targets: overrides.targets ?? targets,
  };
  const signedPayload = canonicalReleasePayload(unsigned);
  const signer = createSign("sha256");
  signer.update(signedPayload);
  signer.end();

  return { ...unsigned, signature: signer.sign(privateKey, "base64"), signedPayload };
}

describe("signed release metadata", () => {
  it("REQ-PKG-006: serializes target entries in target-name order", () => {
    expect(canonicalReleasePayload({
      schemaVersion: 1,
      version: "0.2.0",
      url: "https://updates.test/release.json",
      targets,
    })).toBe("{\"schemaVersion\":1,\"version\":\"0.2.0\",\"url\":\"https://updates.test/release.json\",\"targets\":[{\"target\":\"linux-x64\",\"url\":\"https://updates.test/theaihatch-0.2.0-linux-x64\",\"sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"},{\"target\":\"windows-x64\",\"url\":\"https://updates.test/theaihatch-0.2.0-windows-x64.exe\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}]}");
  });

  it("REQ-PKG-006: binds the signature to the release fields", () => {
    const signed = signRelease();
    const changedUrl = { ...signed, url: "https://updates.test/other.json" };
    const changedDigest = {
      ...signed,
      targets: [{ ...signed.targets[0]!, sha256: "c".repeat(64) }, ...signed.targets.slice(1)],
    };

    expect(verifyReleaseMetadata(signed, publicKey)).toBe(true);
    expect(verifyReleaseMetadata(changedUrl, publicKey)).toBe(false);
    expect(verifyReleaseMetadata(changedDigest, publicKey)).toBe(false);
  });

  it("REQ-PKG-006: rejects malformed signed payloads and signatures", () => {
    const signed = signRelease();

    expect(verifyReleaseMetadata({ ...signed, signedPayload: "not json" }, publicKey)).toBe(false);
    expect(verifyReleaseMetadata({ ...signed, signature: "invalid" }, publicKey)).toBe(false);
  });

  it.each([
    ["0.1.0", "0.2.0", true],
    ["0.2.0", "0.2.0", false],
    ["0.3.0", "0.2.0", false],
    ["0.2", "0.2.0", false],
    ["0.2.0", "v0.3.0", false],
    ["0.2.0", "0.3.0-beta", false],
    ["0.2.0", "01.3.0", false],
  ])("compares strict versions: %s to %s", (currentVersion, candidateVersion, expected) => {
    expect(isNewerVersion(currentVersion, candidateVersion)).toBe(expected);
  });

  it("returns a verified newer release", async () => {
    const signed = signRelease();
    const result = await checkSignedRelease("https://updates.test/release.json", publicKey, new UpdateChecker(), {
      currentVersion: "0.1.0",
      fetcher: async () => new Response(JSON.stringify(signed)),
    });

    expect(result).toEqual(signed);
  });

  it("rejects non-HTTPS release URLs before fetching", async () => {
    let calls = 0;
    const result = await checkSignedRelease("http://updates.test/release.json", publicKey, new UpdateChecker(), {
      currentVersion: "0.1.0",
      fetcher: async () => {
        calls += 1;
        return new Response();
      },
    });

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("returns no release when offline", async () => {
    const result = await checkSignedRelease("https://updates.test/release.json", publicKey, new UpdateChecker(), {
      currentVersion: "0.1.0",
      fetcher: async () => { throw new Error("offline"); },
    });

    expect(result).toBeNull();
  });

  it("aborts a release fetch at the configured deadline", async () => {
    let aborted = false;
    const fetcher: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });

    const result = await checkSignedRelease("https://updates.test/release.json", publicKey, new UpdateChecker(), {
      currentVersion: "0.1.0",
      fetcher,
      timeoutMs: 5,
    });

    expect(result).toBeNull();
    expect(aborted).toBe(true);
  });

  it("does not report a verified release equal to the running version", async () => {
    const signed = signRelease({ version: "0.2.0" });
    const result = await checkSignedRelease("https://updates.test/release.json", publicKey, new UpdateChecker(), {
      currentVersion: "0.2.0",
      fetcher: async () => new Response(JSON.stringify(signed)),
    });

    expect(result).toBeNull();
  });

  it("requires the caller to provide the running version", async () => {
    let calls = 0;
    const result = await checkSignedRelease("https://updates.test/release.json", publicKey, new UpdateChecker(), {
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify(signRelease()));
      },
    });

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("allows only one concurrent release check to begin fetching", async () => {
    const signed = signRelease();
    let calls = 0;
    let resolveResponse: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return response;
    };
    const checker = new UpdateChecker(100);
    const options = { currentVersion: "0.1.0", fetcher };

    const first = checkSignedRelease("https://updates.test/release.json", publicKey, checker, options);
    const second = checkSignedRelease("https://updates.test/release.json", publicKey, checker, options);

    expect(calls).toBe(1);
    expect(await second).toBeNull();
    resolveResponse!(new Response(JSON.stringify(signed)));
    await expect(first).resolves.toEqual(signed);
  });

  it("counts failed attempts against the rate limit", async () => {
    const checker = new UpdateChecker(100);
    const now = () => 1_000;
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      throw new Error("offline");
    };

    await expect(checkSignedRelease("https://updates.test/release.json", publicKey, checker, { currentVersion: "0.1.0", now, fetcher })).resolves.toBeNull();
    await expect(checkSignedRelease("https://updates.test/release.json", publicKey, checker, { currentVersion: "0.1.0", now, fetcher })).resolves.toBeNull();

    expect(calls).toBe(1);
  });
});
