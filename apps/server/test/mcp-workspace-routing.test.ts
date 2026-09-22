import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createServer } from "../src/app.js";

const token = "routing-token";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

async function makeRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `theaihatch-routing-${label}-`));
  directories.push(root);
  return root;
}

it("routes each MCP client to the workspace it names, not the one opened last", async () => {
  const data = await makeRoot("data");
  const alpha = await makeRoot("alpha");
  const beta = await makeRoot("beta");
  const app = createServer(undefined, token, undefined, data);
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const open = async (root: string): Promise<void> => { await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: root }) }); };
    await open(alpha);
    await open(beta); // beta is now registry.latest(), so an unrouted client would write here

    const edit = async (workspace: string | undefined, content: string): Promise<Response> => fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(workspace === undefined ? {} : { "x-theaihatch-workspace": workspace }) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "edit_file", arguments: { path: "routed.txt", content } } })
    });

    // The header wins over recency: this must land in alpha even though beta was opened last.
    expect((await edit(alpha, "into alpha\n")).status).toBe(200);
    expect(await fs.readFile(path.join(alpha, "routed.txt"), "utf8")).toBe("into alpha\n");
    await expect(fs.readFile(path.join(beta, "routed.txt"), "utf8")).rejects.toThrow();

    expect((await edit(beta, "into beta\n")).status).toBe(200);
    expect(await fs.readFile(path.join(beta, "routed.txt"), "utf8")).toBe("into beta\n");
    expect(await fs.readFile(path.join(alpha, "routed.txt"), "utf8")).toBe("into alpha\n");

    // No header keeps the previous single-project behaviour: the most recently opened workspace.
    expect((await edit(undefined, "unrouted\n")).status).toBe(200);
    expect(await fs.readFile(path.join(beta, "routed.txt"), "utf8")).toBe("unrouted\n");

    // A workspace nobody opened fails loudly rather than writing into a neighbouring tree.
    const stray = await makeRoot("stray");
    const refused = await edit(stray, "should not land\n");
    expect(JSON.stringify(await refused.json())).toContain("workspace is not open");
    await expect(fs.readFile(path.join(stray, "routed.txt"), "utf8")).rejects.toThrow();
  } finally {
    await app.close();
  }
});
