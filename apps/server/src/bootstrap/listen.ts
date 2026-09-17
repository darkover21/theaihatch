import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
const run = promisify(execFile);
export async function findLoopbackPort(preferred: number, fallbackCount = 20): Promise<number> { for (let candidate = preferred; candidate < preferred + fallbackCount; candidate += 1) { const server = net.createServer(); try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(candidate, "127.0.0.1", () => resolve()); }); const address = server.address(); const port = typeof address === "object" && address !== null ? address.port : candidate; await new Promise<void>((resolve) => server.close(() => resolve())); return port; } catch { server.close(); } } throw new Error("no available loopback port in fallback range"); }
export async function openBrowser(url: string, platform = process.platform): Promise<void> { if (platform === "win32") await run("cmd", ["/c", "start", "", url]); else if (platform === "darwin") await run("open", [url]); else await run("xdg-open", [url]); }
