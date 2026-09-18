import { expect, it } from "vitest";
import { createPackagedAssetProvider } from "../src/bootstrap/assets.js";

it("serves SEA bytes and rejects missing/traversal paths without filesystem fallback", async () => {
  const assets = new Map([
    ["web-index", Buffer.from('["web/index.html","web/assets/app.js"]')],
    ["web/index.html", Buffer.from("<h1>embedded</h1>")],
    ["web/assets/app.js", Buffer.from("console.log(42)")],
  ]);
  const provider = await createPackagedAssetProvider((key) => {
    const bytes = assets.get(key);
    if (!bytes) throw new Error(`Missing embedded asset ${key}`);
    return bytes;
  });
  expect((await provider.read("/index.html"))?.body.toString()).toBe("<h1>embedded</h1>");
  expect((await provider.read("assets/app.js"))?.contentType).toContain("javascript");
  expect(await provider.read("../package.json")).toBeNull();
  expect(await provider.read("missing.html")).toBeNull();
  assets.delete("web/index.html");
  await expect(provider.read("index.html")).rejects.toThrow("Missing embedded asset web/index.html");
});

it("fails on a missing embedded web entry instead of using development assets", async () => {
  await expect(createPackagedAssetProvider(() => Buffer.from("[]"))).rejects.toThrow(/index.html/);
});
