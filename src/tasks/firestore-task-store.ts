/**
 * Firestore-backed TaskStore.
 *
 * The in-memory store the SDK ships is fine for a single process, but on
 * Cloud Run the `tasks/get` poll routinely lands on a different instance than
 * the `tools/call` that created the task. Firestore is the shared surface both
 * instances can see, mirroring how src/auth/firestore-token-store.ts already
 * keeps OAuth tokens outside the container.
 *
 * Collection layout:
 *   {collection}/{taskId}   — task metadata, plus the stored result once terminal
 *
 * Expiry is enforced on read against `expiresAt`; set a Firestore TTL policy on
 * that field to have Firestore reclaim the documents.
 */

import { Firestore } from '@google-cloud/firestore';
import type { Task, Result, Request, RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { TaskStore, CreateTaskOptions } from '@modelcontextprotocol/sdk/experimental/index.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

/** Upper bound on client-requested TTL, so one caller can't pin a document forever. */
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const LIST_PAGE_SIZE = 50;

interface TaskDocument extends Task {
  /** Present once the task reaches a terminal status. */
  result?: Result;
  /** Epoch ms after which the task is treated as gone. Null means no expiry. */
  expiresAt: number | null;
  /** Session that owns the task, when the transport is stateful. */
  sessionId?: string;
}

export class FirestoreTaskStore implements TaskStore {
  private readonly db: Firestore;
  private readonly collection: string;

  constructor(opts: { collection?: string; projectId?: string } = {}) {
    this.collection = opts.collection ?? 'mcp_tasks';
    this.db = new Firestore({ projectId: opts.projectId });
    logger.info('Firestore task store initialized', { collection: this.collection });
  }

  private doc(taskId: string) {
    return this.db.collection(this.collection).doc(taskId);
  }

  private async read(taskId: string, sessionId?: string): Promise<TaskDocument | null> {
    const snap = await this.doc(taskId).get();
    if (!snap.exists) return null;
    const data = snap.data() as TaskDocument;
    if (data.expiresAt !== null && data.expiresAt <= Date.now()) return null;
    // A stateful session must not be able to read another session's tasks.
    // Stateless requests carry no session ID and are scoped by task ID alone.
    if (sessionId && data.sessionId && data.sessionId !== sessionId) return null;
    return data;
  }

  async createTask(
    taskParams: CreateTaskOptions,
    _requestId: RequestId,
    _request: Request,
    sessionId?: string,
  ): Promise<Task> {
    const now = Date.now();
    const requested = taskParams.ttl === undefined ? DEFAULT_TTL_MS : taskParams.ttl;
    const ttl = requested === null ? null : Math.min(Math.max(requested, 0), MAX_TTL_MS);
    const timestamp = new Date(now).toISOString();

    const task: Task = {
      taskId: randomUUID(),
      status: 'working',
      ttl,
      createdAt: timestamp,
      lastUpdatedAt: timestamp,
    };
    if (taskParams.pollInterval !== undefined) task.pollInterval = taskParams.pollInterval;

    const document: TaskDocument = {
      ...task,
      expiresAt: ttl === null ? null : now + ttl,
      ...(sessionId ? { sessionId } : {}),
    };
    await this.doc(task.taskId).set(document);
    return task;
  }

  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const doc = await this.read(taskId, sessionId);
    if (!doc) return null;
    const { result: _result, expiresAt: _expiresAt, sessionId: _sessionId, ...task } = doc;
    return task;
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    const doc = await this.read(taskId, sessionId);
    if (!doc) throw new Error(`Task not found: ${taskId}`);
    // A cancelled task has already been reported as terminal; overwriting it
    // would resurrect work the client explicitly abandoned.
    if (doc.status === 'cancelled') return;

    const now = Date.now();
    // The retention clock starts when the result lands, not when the task did.
    const expiresAt = doc.ttl === null ? null : now + doc.ttl;
    await this.doc(taskId).update({
      status,
      result: stripUndefined(result),
      lastUpdatedAt: new Date(now).toISOString(),
      expiresAt,
    });
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    const doc = await this.read(taskId, sessionId);
    if (!doc) throw new Error(`Task not found: ${taskId}`);
    if (!doc.result) throw new Error(`Task has no stored result: ${taskId}`);
    return doc.result;
  }

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    const doc = await this.read(taskId, sessionId);
    if (!doc) throw new Error(`Task not found: ${taskId}`);
    await this.doc(taskId).update({
      status,
      lastUpdatedAt: new Date().toISOString(),
      ...(statusMessage === undefined ? {} : { statusMessage }),
    });
  }

  async listTasks(
    cursor?: string,
    sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    let query = this.db
      .collection(this.collection)
      .orderBy('createdAt', 'desc')
      .limit(LIST_PAGE_SIZE + 1);
    if (sessionId) query = query.where('sessionId', '==', sessionId) as typeof query;
    if (cursor) query = query.startAfter(decodeCursor(cursor)) as typeof query;

    const snap = await query.get();
    const now = Date.now();
    const docs = snap.docs
      .map((d) => d.data() as TaskDocument)
      .filter((d) => d.expiresAt === null || d.expiresAt > now);

    const hasMore = docs.length > LIST_PAGE_SIZE;
    const page = hasMore ? docs.slice(0, LIST_PAGE_SIZE) : docs;
    const tasks = page.map(({ result: _r, expiresAt: _e, sessionId: _s, ...task }) => task);
    const last = page[page.length - 1];
    return hasMore && last ? { tasks, nextCursor: encodeCursor(last.createdAt) } : { tasks };
  }
}

function encodeCursor(createdAt: string): string {
  return Buffer.from(createdAt).toString('base64url');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

/** Firestore rejects `undefined`; tool results legitimately contain optional fields. */
function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => stripUndefined(v)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}
