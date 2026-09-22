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
import { SessionRepository } from "@theaihatch/storage";
import { acquireLock, releaseLock, resolveSession, SessionProgressReporter } from "../workspace/session-store.js";
import { hashContent, recordCommittedEdit } from "../agent/ses-recorder.js";

const openWorkspaceBody = z.object({ path: z.string().min(1) }).strict();
const workspaceParams = z.object({ id: z.string().uuid() }).strict();
const treeQuery = z.object({ path: z.string().optional() }).strict();
const fileQuery = z.object({ path: z.string().min(1) }).strict();
const fileWriteBody = z.object({ path: z.string().min(1), content: z.string() }).strict();
// headSeq and resumed let the client tell "reattached to an existing recording" from "fresh folder".
const workspaceResponse = z.object({ id: z.string().uuid(), rootName: z.string(), canonicalRoot: z.string(), headSeq: z.number().int(), resumed: z.boolean() }).strict();
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
  readonly resumed: boolean;
  externalQueue: Promise<void>;
  demoEvents: AnySesEvent[] | null;
  gitStatus: GitStatusSnapshot;
}

export class WorkspaceRegistry {
  private readonly records = new Map<string, WorkspaceRecord>();
  private sessions: SessionRepository | null = null;
  private readonly reporters = new Map<string, SessionProgressReporter>();

  constructor(private readonly eventSink: WorkspaceEventSink = () => undefined, private readonly dataDirectory = userPaths().data) {}

  // Opened lazily so constructing a registry never creates a SQLite file; several tests build one and
  // never open a workspace.
  private sessionRepository(): SessionRepository {
    this.sessions ??= new SessionRepository(this.dataDirectory);
    return this.sessions;
  }

  async emit(event: Parameters<WorkspaceStream["append"]>[0]): Promise<AnySesEvent[]> {
    const record = this.records.size > 0 ? [...this.records.values()].at(-1) : undefined;
    if (record === undefined) return [];
    return record.stream.append(event);
  }

  async open(candidate: string): Promise<WorkspaceRecord> {
    const tree = await WorkspaceTree.open(candidate);
    // Opening a folder that is already open returns the same record. Without this, a reload created a
    // second watcher and a second writer over the same tree, and the older stream was abandoned.
    const alreadyOpen = await this.byRoot(tree.root.canonicalPath);
    if (alreadyOpen !== undefined) return alreadyOpen;

    const sessions = this.sessionRepository();
    const resolved = await resolveSession(sessions, this.dataDirectory, tree.root.canonicalPath);
    const watcher = new WorkspaceWatcher(tree);
    const id = resolved.id;
    await acquireLock(this.dataDirectory, id);
    const stream = await WorkspaceStream.open(this.dataDirectory, id);
    const reporter = new SessionProgressReporter(sessions, id, stream.integrity);
    stream.observeProgress((headSeq, durationMs, isCheckpoint) => reporter.record(headSeq, durationMs, isCheckpoint));
    this.reporters.set(id, reporter);
    sessions.markStarted(id);
    stream.subscribe(0, (event) => this.eventSink(event));
    const record: WorkspaceRecord = { id, tree, watcher, stream, resumed: resolved.resumed, externalQueue: Promise.resolve(), changes: [], changeLog: new ChangeLog(), demoEvents: null, gitStatus: await readGitStatus(tree.root) };
    watcher.subscribe((change) => {
      record.changes.push(change);
      if (record.changes.length > 100) record.changes.shift();
      record.changeLog.append(change);
      if (change.path === ".gitignore") void record.tree.reloadIgnoreRules();
      // One write can surface as several raw watcher events. Serializing keeps plan-then-emit atomic, so a
      // later event always sees the content the earlier one recorded and suppresses itself as an echo.
      if (process.env.THEAIHATCH_WATCH_PRODUCER === "1") record.externalQueue = record.externalQueue.then(() => recordExternalChange(record, change)).catch(() => undefined);
    });
    await watcher.start();
    this.records.set(record.id, record);
    // A resumed session records that the folder was reopened, which also gives the timeline a marker.
    await record.stream.append({ type: "workspace_open", payload: { rootName: tree.root.rootName, canonicalRoot: tree.root.canonicalPath } });
    return record;
  }

  get(id: string): WorkspaceRecord {
    const record = this.records.get(id);
    if (record === undefined) throw new Error("workspace handle is not active");
    return record;
  }

  // Resolves the workspace an inbound client names, so several projects can share one server without
  // their edits landing in whichever tree happened to be opened last. Roots are stored realpath'd, so
  // the lookup canonicalizes too rather than comparing a caller's lexical path against a resolved one.
  async byRoot(candidate: string): Promise<WorkspaceRecord | undefined> {
    const target = await fs.realpath(candidate).catch(() => path.resolve(candidate));
    return [...this.records.values()].find((record) => record.tree.root.canonicalPath === target);
  }

  latest(): WorkspaceRecord {
    const record = [...this.records.values()].at(-1);
    if (record === undefined) throw new Error("no workspace is active");
    return record;
  }

  async close(id: string): Promise<void> {
    const record = this.get(id);
    await record.watcher.stop();
    await record.externalQueue;
    await record.stream.close();
    const reporter = this.reporters.get(id);
    reporter?.flush();
    this.reporters.delete(id);
    try {
      this.sessionRepository().markEnded(id, "completed");
    } catch {
      // Metadata is a convenience; a closed workspace must not fail because SQLite did.
    }
    // Released last, so nothing else can claim the session while this one is still writing to it.
    await releaseLock(this.dataDirectory, id);
    this.records.delete(id);
  }

  /** Closes every open workspace, so shutdown releases each session's writer lock. */
  async closeAll(): Promise<void> {
    for (const id of [...this.records.keys()]) await this.close(id).catch(() => undefined);
    this.sessions?.close();
    this.sessions = null;
  }

  async refreshGitStatus(id: string): Promise<GitStatusSnapshot> {
    const record = this.get(id);
    record.gitStatus = await readGitStatus(record.tree.root);
    return record.gitStatus;
  }
}

type ExternalEdit = { kind: "delete" } | { kind: "edit"; before: string; after: string; created: boolean };

// A watcher event that only echoes a write this stream already recorded must produce no events at all,
// not an empty step: the projection is the record of what we wrote, so an unchanged hash means our own echo.
async function planExternalChange(record: WorkspaceRecord, change: WorkspaceChange): Promise<ExternalEdit | null> {
  if (change.kind === "delete") {
    const current = record.stream.currentFiles.get(change.path);
    return current === undefined || current === null ? null : { kind: "delete" };
  }
  const bytes = await fs.readFile(record.tree.absolute(change.path)).catch(() => null);
  if (bytes === null || bytes.length > 1_000_000 || bytes.includes(0)) return null;
  const after = bytes.toString("utf8");
  if (after.includes("\uFFFD")) return null;
  const before = record.stream.currentFiles.get(change.path);
  if (before !== null && before !== undefined && hashContent(before) === hashContent(after)) return null;
  return { kind: "edit", before: before ?? "", after, created: before === undefined };
}

async function recordExternalChange(record: WorkspaceRecord, change: WorkspaceChange): Promise<void> {
  const planned = await planExternalChange(record, change).catch(() => null);
  if (planned === null) return;
  // A tool call writes to disk before it appends file_save, so the watcher can fire mid-step. Opening an
  // external step there would close the tool's step early; the next watcher event still carries the change.
  if (record.stream.hasOpenStep) return;
  const stepId = `external-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await record.stream.append({ type: "step_begin", payload: { stepId, label: "External change", primaryPath: change.path } });
    if (planned.kind === "delete") await record.stream.append({ type: "file_delete", payload: { path: change.path } });
    else await recordCommittedEdit(record.stream, { path: change.path, before: planned.before, after: planned.after, created: planned.created });
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
      return workspaceResponse.parse({ id: record.id, rootName: record.tree.root.rootName, canonicalRoot: record.tree.root.canonicalPath, headSeq: record.stream.headSeq, resumed: record.resumed });
    } catch (error) {
      return sendError(reply, 400, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/workspaces/:id/tree", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      const query = treeQuery.parse(request.query);
      const record = registry.get(params.id);
      await record.watcher.ensureWatched(query.path ?? ".");
      const entries = await record.tree.list(query.path ?? ".");
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
      await record.watcher.ensureWatched(path.posix.dirname(normalized));
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
      let before = "";
      let created = false;
      try { before = await record.tree.readFile(normalized); } catch { created = true; }
      await record.tree.writeFile(normalized, body.content);
      await recordCommittedEdit(record.stream, { path: normalized, before, after: body.content, created });
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
    // A stale id — a workspace closed, or the server restarted under a still-open tab — must answer 404
    // like every other route. Throwing here produced a 500, which closes an EventSource permanently
    // with no retry, so the page silently stopped receiving events.
    let record: WorkspaceRecord;
    try {
      record = registry.get(workspaceParams.parse(request.params).id);
    } catch (error) {
      return sendError(reply, 404, error);
    }
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
