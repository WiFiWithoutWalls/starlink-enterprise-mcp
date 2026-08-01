/**
 * FirestoreTaskStore — the store that makes tasks work across instances.
 *
 * Firestore is faked in-process here; what is under test is the store's own
 * logic: TTL clamping, expiry on read, session scoping, and the rule that a
 * cancelled task cannot be resurrected by late-arriving work.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const docs = new Map<string, Record<string, unknown>>();

/** Minimal stand-in for the slice of the Firestore API the store uses. */
class FakeFirestore {
  collection(name: string) {
    const prefix = `${name}/`;
    const makeQuery = (filters: {
      sessionId?: string;
      startAfter?: string;
      limit?: number;
    }): any => ({
      orderBy: () => makeQuery(filters),
      limit: (n: number) => makeQuery({ ...filters, limit: n }),
      where: (_f: string, _op: string, value: string) => makeQuery({ ...filters, sessionId: value }),
      startAfter: (cursor: string) => makeQuery({ ...filters, startAfter: cursor }),
      get: async () => {
        let rows = [...docs.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, value]) => value)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        if (filters.sessionId) rows = rows.filter((r) => r.sessionId === filters.sessionId);
        if (filters.startAfter) {
          rows = rows.filter((r) => String(r.createdAt) < filters.startAfter!);
        }
        if (filters.limit) rows = rows.slice(0, filters.limit);
        return { docs: rows.map((data) => ({ data: () => data })) };
      },
    });

    return Object.assign(makeQuery({}), {
      doc: (id: string) => ({
        get: async () => {
          const data = docs.get(prefix + id);
          return { exists: data !== undefined, data: () => data };
        },
        set: async (data: Record<string, unknown>) => {
          docs.set(prefix + id, { ...data });
        },
        update: async (patch: Record<string, unknown>) => {
          const existing = docs.get(prefix + id);
          if (!existing) throw new Error('missing document');
          docs.set(prefix + id, { ...existing, ...patch });
        },
      }),
    });
  }
}

vi.mock('@google-cloud/firestore', () => ({ Firestore: FakeFirestore }));

const { FirestoreTaskStore } = await import('../tasks/firestore-task-store.js');

const REQUEST = { method: 'tools/call', params: { name: 'get_account' } };

function newStore() {
  return new FirestoreTaskStore({ collection: 'tasks' });
}

beforeEach(() => {
  docs.clear();
  vi.useRealTimers();
});

describe('lifecycle', () => {
  it('creates a working task and reads it back', async () => {
    const store = newStore();
    const task = await store.createTask({ ttl: 60_000, pollInterval: 500 }, 1, REQUEST);

    expect(task.status).toBe('working');
    expect(task.ttl).toBe(60_000);
    expect(task.pollInterval).toBe(500);

    const fetched = await store.getTask(task.taskId);
    expect(fetched!.taskId).toBe(task.taskId);
    // Internal bookkeeping must not leak into the protocol object.
    expect(fetched).not.toHaveProperty('expiresAt');
    expect(fetched).not.toHaveProperty('result');
  });

  it('stores and returns a result', async () => {
    const store = newStore();
    const task = await store.createTask({}, 1, REQUEST);
    const result = { content: [{ type: 'text', text: 'ok' }], structuredContent: { a: 1 } };

    await store.storeTaskResult(task.taskId, 'completed', result);

    expect((await store.getTask(task.taskId))!.status).toBe('completed');
    expect(await store.getTaskResult(task.taskId)).toEqual(result);
  });

  it('drops undefined values Firestore would reject', async () => {
    const store = newStore();
    const task = await store.createTask({}, 1, REQUEST);
    await store.storeTaskResult(task.taskId, 'completed', {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: undefined,
    } as never);

    const stored = await store.getTaskResult(task.taskId);
    expect(Object.keys(stored)).not.toContain('structuredContent');
  });

  it('refuses to resurrect a cancelled task', async () => {
    const store = newStore();
    const task = await store.createTask({}, 1, REQUEST);
    await store.updateTaskStatus(task.taskId, 'cancelled', 'client cancelled');

    await store.storeTaskResult(task.taskId, 'completed', { content: [] });

    expect((await store.getTask(task.taskId))!.status).toBe('cancelled');
  });

  it('throws when storing a result for a task that does not exist', async () => {
    await expect(newStore().storeTaskResult('nope', 'completed', { content: [] })).rejects.toThrow(
      /Task not found/,
    );
  });
});

describe('ttl and expiry', () => {
  it('clamps an oversized ttl to the 24h ceiling', async () => {
    const store = newStore();
    const task = await store.createTask({ ttl: 7 * 24 * 60 * 60 * 1000 }, 1, REQUEST);
    expect(task.ttl).toBe(24 * 60 * 60 * 1000);
  });

  it('honours an unlimited ttl', async () => {
    const store = newStore();
    const task = await store.createTask({ ttl: null }, 1, REQUEST);
    expect(task.ttl).toBeNull();
  });

  it('treats an expired task as gone', async () => {
    const store = newStore();
    const task = await store.createTask({ ttl: 1000 }, 1, REQUEST);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5000);

    expect(await store.getTask(task.taskId)).toBeNull();
    expect((await store.listTasks()).tasks).toEqual([]);
  });

  it('restarts the retention clock when the result lands', async () => {
    const store = newStore();
    const task = await store.createTask({ ttl: 10_000 }, 1, REQUEST);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 9000);
    await store.storeTaskResult(task.taskId, 'completed', { content: [] });

    // Past the original expiry, but inside the fresh window the result opened.
    vi.setSystemTime(Date.now() + 5000);
    expect(await store.getTask(task.taskId)).not.toBeNull();
  });
});

describe('session scoping', () => {
  it('hides a task from a different session', async () => {
    const store = newStore();
    const task = await store.createTask({}, 1, REQUEST, 'session-a');

    expect(await store.getTask(task.taskId, 'session-a')).not.toBeNull();
    expect(await store.getTask(task.taskId, 'session-b')).toBeNull();
  });

  it('lets a stateless request reach a task by ID alone', async () => {
    // Stateless requests carry no session, and the task ID is unguessable.
    const store = newStore();
    const task = await store.createTask({}, 1, REQUEST, 'session-a');
    expect(await store.getTask(task.taskId)).not.toBeNull();
  });
});

describe('listing', () => {
  it('pages through tasks newest first', async () => {
    const store = newStore();
    const created: string[] = [];
    // Unlimited ttl, so rewinding the clock to space out createdAt does not
    // also expire the tasks out from under the assertion.
    for (let i = 0; i < 3; i++) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
      created.push((await store.createTask({ ttl: null }, i, REQUEST)).taskId);
    }
    vi.useRealTimers();

    const { tasks } = await store.listTasks();
    expect(tasks.map((t) => t.taskId)).toEqual([...created].reverse());
  });

  it('filters by session', async () => {
    const store = newStore();
    await store.createTask({}, 1, REQUEST, 'session-a');
    await store.createTask({}, 2, REQUEST, 'session-b');

    const { tasks } = await store.listTasks(undefined, 'session-a');
    expect(tasks.length).toBe(1);
  });
});
