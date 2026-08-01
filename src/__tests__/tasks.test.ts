/**
 * Task augmentation (MCP 2025-11-25, SEP-1686).
 *
 * Exercised through the real transport, because the point of tasks is that the
 * result outlives the request that started it: the tools/call, the tasks/get
 * poll, and the tasks/result fetch are three separate HTTP requests, each served
 * by its own Server instance in stateless mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { StarlinkAuthProvider } from '../auth/starlink-auth-provider.js';

vi.mock('axios');

const ORIG_ENV = { ...process.env };
const BEARER = 'test-mcp-token';

async function buildApp(env: Record<string, string> = {}): Promise<Express> {
  Object.assign(process.env, env);
  const { createApp } = await import('../http-server.js');
  const { app, authProvider } = await createApp();
  vi.spyOn(authProvider as StarlinkAuthProvider, 'verifyAccessToken').mockResolvedValue({
    token: BEARER,
    clientId: 'test-client',
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    extra: { starlinkAccessToken: 'starlink-token' },
  } as never);
  return app;
}

function readRpc(res: request.Response): any {
  const contentType = res.headers['content-type'] || '';
  if (contentType.includes('text/event-stream')) {
    const lines = String(res.text)
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = JSON.parse(lines[i]);
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
    }
    throw new Error(`No JSON-RPC response in stream: ${String(res.text).slice(0, 300)}`);
  }
  return res.body;
}

function post(app: Express, payload: unknown) {
  return request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${BEARER}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send(payload as object);
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: { tasks: { requests: { tools: { call: {} } } } },
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
};

beforeEach(() => {
  process.env = { ...ORIG_ENV };
  process.env.MCP_TRANSPORT = 'http';
  process.env.MCP_PERSISTENCE = 'file';
  process.env.MCP_SESSION_SECRET = 'test-secret-at-least-16-chars-long';
  process.env.MCP_BASE_URL = 'http://localhost:3000';
  delete process.env.GOOGLE_CLOUD_PROJECT;
  vi.mocked(axios.create).mockReset();
  vi.mocked(axios.create).mockReturnValue({
    request: vi.fn().mockResolvedValue({ data: { content: { accountNumber: 'ACC-1' } } }),
  } as unknown as AxiosInstance);
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

describe('tasks capability', () => {
  it('is absent by default', async () => {
    const app = await buildApp();
    const rpc = readRpc(await post(app, INITIALIZE));
    expect(rpc.result.capabilities.tasks).toBeUndefined();
  });

  it('advertises list, cancel, and task-augmented tools/call when enabled', async () => {
    const app = await buildApp({ MCP_TASKS: 'true' });
    const rpc = readRpc(await post(app, INITIALIZE));
    expect(rpc.result.capabilities.tasks).toEqual({
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    });
  });

  it('refuses tasks/get when tasks are off', async () => {
    const app = await buildApp();
    const rpc = readRpc(
      await post(app, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: 'x' } }),
    );
    expect(rpc.error).toBeDefined();
  });
});

describe('task-augmented tools/call', () => {
  it('returns a task handle instead of the result', async () => {
    const app = await buildApp({ MCP_TASKS: 'true' });
    const rpc = readRpc(
      await post(app, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_account', arguments: {}, task: { ttl: 60000 } },
      }),
    );

    expect(rpc.error).toBeUndefined();
    expect(rpc.result.task.taskId).toBeTruthy();
    expect(rpc.result.task.status).toBe('working');
    expect(rpc.result.content).toBeUndefined();
  });

  it('delivers the result on a later request, over a different Server instance', async () => {
    const app = await buildApp({ MCP_TASKS: 'true' });
    const created = readRpc(
      await post(app, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_account', arguments: {}, task: { ttl: 60000 } },
      }),
    );
    const { taskId } = created.result.task;

    // tasks/result blocks until the task is terminal, so this needs no polling.
    const fetched = readRpc(
      await post(app, { jsonrpc: '2.0', id: 3, method: 'tasks/result', params: { taskId } }),
    );

    expect(fetched.error).toBeUndefined();
    expect(fetched.result.structuredContent).toEqual({ content: { accountNumber: 'ACC-1' } });
  });

  it('reports the task as completed via tasks/get', async () => {
    const app = await buildApp({ MCP_TASKS: 'true' });
    const created = readRpc(
      await post(app, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_account', arguments: {}, task: {} },
      }),
    );
    const { taskId } = created.result.task;

    // Drain the work before asking, so the assertion is about the recorded
    // status rather than a race with the detached execution.
    readRpc(await post(app, { jsonrpc: '2.0', id: 3, method: 'tasks/result', params: { taskId } }));

    const status = readRpc(
      await post(app, { jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { taskId } }),
    );
    expect(status.result.status).toBe('completed');
    expect(status.result.taskId).toBe(taskId);
  });

  it('lists created tasks', async () => {
    const app = await buildApp({ MCP_TASKS: 'true' });
    await post(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_account', arguments: {}, task: {} },
    });

    const listed = readRpc(await post(app, { jsonrpc: '2.0', id: 3, method: 'tasks/list', params: {} }));
    expect(listed.result.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('records a failing tool call as a completed task carrying an isError result', async () => {
    // The task itself succeeded in running; the tool inside it errored. The
    // model needs to see that error, so it must ride in the stored result.
    vi.mocked(axios.create).mockReturnValue({
      request: vi.fn().mockRejectedValue({ response: { status: 403, data: { error: 'no permission' } } }),
    } as unknown as AxiosInstance);

    const app = await buildApp({ MCP_TASKS: 'true' });
    const created = readRpc(
      await post(app, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_account', arguments: {}, task: {} },
      }),
    );

    const fetched = readRpc(
      await post(app, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/result',
        params: { taskId: created.result.task.taskId },
      }),
    );
    expect(fetched.result.isError).toBe(true);
    expect(fetched.result.content[0].text).toContain('no permission');
  });

  it('cancels an in-flight task', async () => {
    const app = await buildApp({ MCP_TASKS: 'true' });
    // A request that never settles keeps the task in 'working' long enough to cancel.
    vi.mocked(axios.create).mockReturnValue({
      request: vi.fn().mockReturnValue(new Promise(() => {})),
    } as unknown as AxiosInstance);

    const created = readRpc(
      await post(app, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_account', arguments: {}, task: {} },
      }),
    );

    const cancelled = readRpc(
      await post(app, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/cancel',
        params: { taskId: created.result.task.taskId },
      }),
    );
    expect(cancelled.error).toBeUndefined();
    expect(cancelled.result.status).toBe('cancelled');
  });
});
