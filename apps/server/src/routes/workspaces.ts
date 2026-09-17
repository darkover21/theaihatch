import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SesReader, SesWriter, type AnySesEvent, type SesEventInput } from "../ses.js";
import { readGitStatus, WorkspaceTree, WorkspaceWatcher, type GitStatusSnapshot, type WorkspaceChange } from "@theaihatch/workspace";
import { runWorkspaceDemo } from "../scripts/workspace-demo.js";

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

export type WorkspaceEventSink = (event: SesEventInput) => void;

export interface WorkspaceRecord {
  readonly id: string;
  readonly tree: WorkspaceTree;
  readonly watcher: WorkspaceWatcher;
  readonly changes: WorkspaceChange[];
  demoEvents: AnySesEvent[] | null;
  gitStatus: GitStatusSnapshot;
}

export class WorkspaceRegistry {
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(private readonly eventSink: WorkspaceEventSink = () => undefined) {}

  emit(event: SesEventInput): void {
    this.eventSink(event);
  }

  async open(candidate: string): Promise<WorkspaceRecord> {
    const tree = await WorkspaceTree.open(candidate);
    const watcher = new WorkspaceWatcher(tree);
    const record: WorkspaceRecord = { id: randomUUID(), tree, watcher, changes: [], demoEvents: null, gitStatus: await readGitStatus(tree.root) };
    watcher.subscribe((change) => {
      record.changes.push(change);
      if (record.changes.length > 100) record.changes.shift();
    });
    await watcher.start();
    this.records.set(record.id, record);
    this.eventSink({ type: "workspace_open", payload: { rootName: tree.root.rootName, canonicalRoot: tree.root.canonicalPath } });
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
    this.records.delete(id);
  }

  async refreshGitStatus(id: string): Promise<GitStatusSnapshot> {
    const record = this.get(id);
    record.gitStatus = await readGitStatus(record.tree.root);
    return record.gitStatus;
  }
}

function sendError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, statusCode: number, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(statusCode).send(errorResponse.parse({ error: message }));
}

export function registerWorkspaceRoutes(app: FastifyInstance, registry = new WorkspaceRegistry()): WorkspaceRegistry {
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
      registry.emit({ type: "file_open", payload: { path: normalized, preview: false } });
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
      registry.emit({ type: "file_save", payload: { path: normalized, contentHash: "workspace-write" } });
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

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/changes", async (request, reply) => {
    try {
      const params = workspaceParams.parse(request.params);
      return { changes: registry.get(params.id).changes };
    } catch (error) {
      return sendError(reply, 404, error);
    }
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
