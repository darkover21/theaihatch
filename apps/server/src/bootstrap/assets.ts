import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface AssetFile {
  body: Buffer;
  contentType: string;
}

export interface AssetProvider {
  read(logicalPath: string): Promise<AssetFile | null>;
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

function normalizedRelativePath(logicalPath: string): string | null {
  if (logicalPath.includes("\0") || logicalPath.includes("\\")) return null;
  const withoutLeadingSlash = logicalPath.startsWith("/") ? logicalPath.slice(1) : logicalPath;
  if (withoutLeadingSlash.length === 0 || path.posix.isAbsolute(withoutLeadingSlash)) return null;
  if (withoutLeadingSlash.split("/").includes("..")) return null;

  const normalized = path.posix.normalize(withoutLeadingSlash);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function contentType(logicalPath: string): string {
  return contentTypes[path.posix.extname(logicalPath).toLowerCase()] ?? "application/octet-stream";
}

export function createFilesystemAssetProvider(root: string): AssetProvider {
  const resolvedRoot = path.resolve(root);

  return {
    async read(logicalPath: string): Promise<AssetFile | null> {
      const normalizedPath = normalizedRelativePath(logicalPath);
      if (normalizedPath === null) return null;

      const assetPath = path.resolve(resolvedRoot, normalizedPath);
      const relativePath = path.relative(resolvedRoot, assetPath);
      if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return null;

      try {
        const realRoot = await fs.realpath(resolvedRoot);
        const realAssetPath = await fs.realpath(assetPath);
        const realRelativePath = path.relative(realRoot, realAssetPath);
        if (realRelativePath === "" || realRelativePath === ".." || realRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(realRelativePath)) return null;

        return { body: await fs.readFile(realAssetPath), contentType: contentType(normalizedPath) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
        throw error;
      }
    },
  };
}

export function createEmbeddedAssetProvider(readAsset: (key: string) => Promise<Buffer | null>, prefix = "web"): AssetProvider {
  const normalizedPrefix = prefix.replace(/\/+$/u, "");

  return {
    async read(logicalPath: string): Promise<AssetFile | null> {
      const normalizedPath = normalizedRelativePath(logicalPath);
      if (normalizedPath === null) return null;

      const key = normalizedPrefix.length > 0 ? `${normalizedPrefix}/${normalizedPath}` : normalizedPath;
      const body = await readAsset(key);
      return body === null ? null : { body, contentType: contentType(normalizedPath) };
    },
  };
}

async function sendAsset(provider: AssetProvider, logicalPath: string, reply: FastifyReply): Promise<void> {
  const asset = await provider.read(logicalPath);
  if (asset === null) {
    reply.callNotFound();
    return;
  }
  reply.type(asset.contentType).send(asset.body);
}

export function registerWebAssets(app: FastifyInstance, provider: AssetProvider): void {
  app.get("/", async (_request, reply) => sendAsset(provider, "index.html", reply));
  app.get("/*", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      reply.callNotFound();
      return;
    }

    const asset = await provider.read(pathname);
    if (asset !== null) {
      reply.type(asset.contentType).send(asset.body);
      return;
    }
    await sendAsset(provider, "index.html", reply);
  });
}
