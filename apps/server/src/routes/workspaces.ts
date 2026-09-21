import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SesReader, SesWriter, type AnySesEvent } from "../ses.js";
import { ChangeLog, readGitStatus, WorkspaceTree, WorkspaceWatcher, type GitStatusSnapshot, type WorkspaceChange } from "@theaihatch/workspace";
import { userPaths } from "@theaihatch/packaging";
import { runWorkspaceDemo } from "../scripts/workspace-demo.js";
import { WorkspaceStream } from "../workspace/workspace-stream.js";
import { hashContent, recordCommittedEdit } from "../agent/ses-recorder.js";

const openWorkspaceBody = z.object({ path: z.string().min(1) }).strict();
const workspaceParams = z.object({ id: z.string().uuid() }).strict();
const treeQuery = z.object({ path: z.string().optional() }).strict();
const fileQuery = z.object({ path: z.string().min(1) }).strict();
const fileWriteBody = z.object({ path: z.string().min(1), content: z.string() }).strict();
const workspaceResponse = z.object({ id: z.string().uuid(), rootName: z.string(), canonicalRoot: z.string() }).strict();
const entryResponse = z.object({ name: z.string(), path: z.string(), kind: z.enum(["file", "directory"]) }).strict();
const treeResponse = z.object({ entries: z.array(entryResponse) }).strict();
const fileResponse = z.object({ path: z.string(), content: z.string() }).strict();
const demoResponse = z.object({ path: z.string(), status: z.string(), events: z.array(z.unknown()) }).strict();
const errorResponse = z.object({ error: z.string() }).strict();
const changesQuery = z.object({ since: z.coerce.number().int().nonnegative().optional() }).strict();

export type WorkspaceEventSink = (event: AnySesEvent) => void;

export interface WorkspaceRecord {
  readonly id: string;
  readonly tree: WorkspaceTree;
  readonly watcher: WorkspaceWatcher;
  readonly changes: WorkspaceChange[];
  readonly changeLog: ChangeLog<WorkspaceChange>;
  readonly stream: WorkspaceStream;
  demoEvents: AnySesEvent[] | null;
  gitStatus: GitStatusSnapshot;
}

export class WorkspaceRegistry {
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(private readonly eventSink: WorkspaceEventSink = () => undefined, private readonly dataDirectory = userPaths().data) {}

  async emit(event: Parameters<WorkspaceStream["append"]>[0]): Promise<AnySesEvent[]> {
    const record = this.records.size > 0 ? [...this.records.values()].at(-1) : undefined;
    if (record === undefined) return [];
    return record.stream.append(event);
  }

  async open(candidate: string): Promise<WorkspaceRecord> {
    const tree = await WorkspaceTree.open(candidate);
    const watcher = new WorkspaceWatcher(tree);
    const id = randomUUID();
    const stream = await WorkspaceStream.open(this.dataDirectory, id);
    stream.subscribe(0, (event) => this.eventSink(event));
    const record: WorkspaceRecord = { id, tree, watcher, stream, changes: [], changeLog: new ChangeLog(), demoEvents: null, gitStatus: await readGitStatus(tree.root) };
    watcher.subscribe((change) => {
      record.changes.push(change);
      if (record.changes.length > 100) record.changes.shift();
      record.changeLog.append(change);
      if (change.path === ".gitignore") void record.tree.reloadIgnoreRules();
      if (process.env.THEAIHATCH_WATCH_PRODUCER === "1") void recordExternalChange(record, change);
    });
    await watcher.start();
    this.records.set(record.id, record);
    await this.emit({ type: "workspace_open", payload: { rootName: tree.root.rootName, canonicalRoot: tree.root.canonicalPath } });
    return record;
  }

  get(id: string): WorkspaceRecord {
    const record = this.records.get(id);
    if (record === undefined) throw new Error("workspace handle is not active");
    return record;
  }

  latest(): WorkspaceRecord {
    const record = [...this.records.values()].at(-1);
    if (record === undefined) throw new Error("no workspace is active");
    return record;
  }

  async close(id: string): Promise<void> {
    const record = this.get(id);
    await record.watcher.stop();
    await record.stream.close();
    this.records.delete(id);
  }

  async refreshGitStatus(id: string): Promise<GitStatusSnapshot> {
    const record = this.get(id);
    record.gitStatus = await readGitStatus(record.tree.root);
    return record.gitStatus;
  }
}

async function recordExternalChange(record: WorkspaceRecord, change: WorkspaceChange): Promise<void> {
  const stepId = `external-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await record.stream.append({ type: "step_begin", payload: { stepId, label: "External change", primaryPath: change.path } });
    if (change.kind === "delete") {
      if (record.stream.currentFiles.has(change.path) && record.stream.currentFiles.get(change.path) !== null) await record.stream.append({ type: "file_delete", payload: { path: change.path } });
    } else {
      const bytes = await fs.readFile(record.tree.absolute(change.path));
      if (bytes.length <= 1_000_000 && !bytes.includes(0)) {
        const content = bytes.toString("utf8");
        if (!content.includes("\uFFFD")) {
          const before = record.stream.currentFiles.get(change.path);
          if (before === null || before === undefined || hashContent(before) !== hashContent(content)) {
            await recordCommittedEdit(record.stream, { path: change.path, before: before ?? "", after: content, created: before === undefined });
          }
        }
      }
    }
    await record.stream.append({ type: "step_end", payload: { stepId, outcome: "succeeded" } });
  } catch {
    try { await record.stream.append({ type: "step_end", payload: { stepId, outcome: "failed" } }); } catch { /* stream is closing */ }
  }
}

function sendError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, statusCode: number, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(statusCode).send(errorResponse.parse({ error: message }));
}

export function registerWorkspaceRoutes(app: FastifyInstance, registry = new WorkspaceRegistry()): WorkspaceRegistry {
  const sockets = new Set<NodeJS.WritableStream>();
  app.addHook("onClose", async () => { for (const socket of sockets) socket.end(); sockets.clear(); });
  app.post("/api/workspaces", async (request, reply) => {
    try {
      const body = openWorkspaceBody.parse(request.body);
      const record = await registry.open(body.path);
      return workspaceResponse.parse({ id: record.id, rootName: record.tree.root.rootName, canonicalRoot: record.tree.root.canonicalPath });
    } catch (error) {
      return sendError(reply, 400, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/workspaces/:id/tree", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      const query = treeQuery.parse(request.query);
      const entries = await registry.get(params.id).tree.list(query.path ?? ".");
      return treeResponse.parse({ entries });
    } catch (error) {
      return sendError(reply, 404, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path: string } }>("/api/workspaces/:id/file", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      const query = fileQuery.parse(request.query);
      const record = registry.get(params.id);
      const normalized = record.tree.normalize(query.path);
      const content = await record.tree.readFile(normalized);
      return fileResponse.parse({ path: normalized, content });
    } catch (error) {
      return sendError(reply, 404, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/workspaces/:id/file", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      const body = fileWriteBody.parse(request.body);
      const record = registry.get(params.id);
      const normalized = record.tree.normalize(body.path);
      await record.tree.writeFile(normalized, body.content);
      await registry.emit({ type: "file_save", payload: { path: normalized, contentHash: createHash("sha256").update(body.content).digest("hex") } });
      return fileResponse.parse({ path: normalized, content: body.content });
    } catch (error) {
      return sendError(reply, 400, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/git-status", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      const status = await registry.refreshGitStatus(params.id);
      return { isRepository: status.isRepository, entries: status.entries, decorations: Object.fromEntries(status.decorations) };
    } catch (error) {
      return sendError(reply, 404, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>("/api/workspaces/:id/changes", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      const record = registry.get(params.id);
      if (request.query.since === undefined) return { changes: record.changes.splice(0) };
      const result = record.changeLog.since(changesQuery.parse(request.query).since ?? 0);
      return { changes: result.entries, cursor: result.cursor, dropped: result.dropped, status: record.gitStatus };
    } catch (error) {
      return sendError(reply, 404, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { fromSeq?: string } }>("/api/workspaces/:id/events", async (request, reply) => {
    const params = workspaceParams.parse(request.params);
    const record = registry.get(params.id);
    const header = request.headers["last-event-id"];
    const fromHeader = typeof header === "string" && /^\d+$/u.test(header) ? Number(header) + 1 : undefined;
    const fromQuery = request.query.fromSeq !== undefined && /^\d+$/u.test(request.query.fromSeq) ? Number(request.query.fromSeq) : undefined;
    const fromSeq = fromHeader ?? fromQuery ?? 0;
    reply.hijack();
    const response = reply.raw;
    sockets.add(response);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    response.write(`event: hello\ndata: ${JSON.stringify({ sessionId: record.id, headSeq: record.stream.headSeq, rootName: record.tree.root.rootName })}\n\n`);
    const queue: AnySesEvent[] = [];
    let ended = false;
    let cleaned = false;
    const send = (event: AnySesEvent): void => {
      if (ended) return;
      if (!response.write(`id: ${event.seq}\nevent: ses\ndata: ${JSON.stringify(event)}\n\n`)) {
        queue.push(event);
        if (queue.length > 2000) {
          ended = true;
          response.write(`event: overflow\ndata: ${JSON.stringify({ nextSeq: event.seq })}\n\n`);
          response.end();
        }
      }
    };
    const unsubscribe = record.stream.subscribe(fromSeq, send);
    const drain = (): void => { while (queue.length > 0 && !ended && response.write(`id: ${queue[0]!.seq}\nevent: ses\ndata: ${JSON.stringify(queue.shift()!)}\n\n`)) { /* drain buffered events */ } };
    response.on("drain", drain);
    const heartbeat = setInterval(() => { if (!ended) response.write(": ping\n\n"); }, 15_000);
    heartbeat.unref();
    const cleanup = (): void => { if (cleaned) return; cleaned = true; ended = true; clearInterval(heartbeat); unsubscribe(); response.off("drain", drain); sockets.delete(response); };
    response.on("close", cleanup);
  });

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/demo", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      const record = registry.get(params.id);
      const sessionDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "theaihatch-workspace-demo-"));
      const writer = await SesWriter.open(sessionDirectory);
      try {
        await writer.append({ type: "workspace_open", payload: { rootName: record.tree.root.rootName, canonicalRoot: record.tree.root.canonicalPath } });
        const result = await runWorkspaceDemo(record.tree, writer);
        await writer.appendCheckpoint("final");
        await writer.close();
        const reader = await SesReader.open(path.join(sessionDirectory, "events.jsonl"));
        record.demoEvents = (await reader.readRange(0, reader.headSeq)).events;
        return demoResponse.parse({ path: result.path, status: result.command.status, events: record.demoEvents });
      } catch (error) {
        await writer.close();
        throw error;
      }
    } catch (error) {
      return sendError(reply, 400, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/demo", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      const events = registry.get(params.id).demoEvents;
      if (events === null) return sendError(reply, 404, "workspace demo has not run");
      return demoResponse.parse({ path: "", status: "replayable", events });
    } catch (error) {
      return sendError(reply, 404, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      await registry.close(params.id);
      return { ok: true };
    } catch (error) {
      return sendError(reply, 404, error);
    }
  });

  return registry;
}
