/**
 * End-to-end tests over the real Streamable HTTP transport.
 *
 * These drive actual JSON-RPC traffic through the Express app rather than
 * calling the registry directly, so they cover the parts that only break in
 * transport: session handling, protocol version negotiation, and whether a
 * fresh server instance can serve a tools/call it never saw an initialize for.
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

/** Stands in for a live Starlink API so tool calls resolve. */
function mockStarlinkApi(response: unknown = { content: { accountNumber: 'ACC-1' } }) {
  const apiRequest = vi.fn().mockResolvedValue({ data: response });
  vi.mocked(axios.create).mockReturnValue({ request: apiRequest } as unknown as AxiosInstance);
  return apiRequest;
}

/**
 * Builds an app whose bearer check passes, without running the OAuth dance —
 * that flow has its own dedicated tests in starlink-auth-provider.test.ts.
 */
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

/**
 * The transport answers a POST with either JSON or an SSE stream depending on
 * configuration, so tests read the payload through this rather than assuming.
 */
function readRpc(res: request.Response): any {
  const contentType = res.headers['content-type'] || '';
  if (contentType.includes('text/event-stream')) {
    const body = typeof res.text === 'string' ? res.text : res.body?.toString?.() ?? '';
    const dataLines = body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    // The last data frame is the response; earlier ones are priming/progress.
    for (let i = dataLines.length - 1; i >= 0; i--) {
      const parsed = JSON.parse(dataLines[i]);
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
    }
    throw new Error(`No JSON-RPC response in SSE stream: ${body.slice(0, 300)}`);
  }
  return res.body;
}

function post(app: Express, payload: unknown, headers: Record<string, string> = {}) {
  const req = request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${BEARER}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(headers)) req.set(key, value);
  return req.send(payload as object);
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
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
  mockStarlinkApi();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  vi.restoreAllMocks();
});

describe('stateless mode (default)', () => {
  it('initializes without handing out a session ID', async () => {
    const app = await buildApp();
    const res = await post(app, INITIALIZE);

    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeUndefined();
    const rpc = readRpc(res);
    expect(rpc.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(rpc.result.serverInfo.name).toBe('starlink-enterprise-mcp');
  });

  it('serves tools/list on a connection that never sent initialize', async () => {
    // This is the case that matters: on an autoscaled host the follow-up
    // request routinely lands on an instance that never saw the handshake.
    const app = await buildApp();
    const res = await post(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    expect(res.status).toBe(200);
    const rpc = readRpc(res);
    expect(rpc.error).toBeUndefined();
    expect(rpc.result.tools.length).toBe(55);
  });

  it('serves a tools/call across two independent app instances', async () => {
    const instanceA = await buildApp();
    const instanceB = await buildApp();

    const init = await post(instanceA, INITIALIZE);
    expect(init.status).toBe(200);

    const call = await post(instanceB, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_account', arguments: {} },
    });

    expect(call.status).toBe(200);
    const rpc = readRpc(call);
    expect(rpc.error).toBeUndefined();
    expect(rpc.result.isError).toBeFalsy();
    expect(rpc.result.structuredContent).toEqual({ content: { accountNumber: 'ACC-1' } });
  });

  it('rejects the standalone GET stream with 405', async () => {
    const app = await buildApp();
    const res = await request(app)
      .get('/mcp')
      .set('Authorization', `Bearer ${BEARER}`)
      .set('Accept', 'text/event-stream');

    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('POST');
  });

  it('accepts DELETE as a no-op rather than failing the client', async () => {
    const app = await buildApp();
    const res = await request(app).delete('/mcp').set('Authorization', `Bearer ${BEARER}`);
    expect(res.status).toBe(200);
  });

  it('returns plain JSON when MCP_JSON_RESPONSE is set', async () => {
    const app = await buildApp({ MCP_JSON_RESPONSE: 'true' });
    const res = await post(app, INITIALIZE);

    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe('session mode (MCP_STATELESS=false)', () => {
  it('issues a session ID and honours it on later requests', async () => {
    const app = await buildApp({ MCP_STATELESS: 'false' });

    const init = await post(app, INITIALIZE);
    expect(init.status).toBe(200);
    const sessionId = init.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();

    const list = await post(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { 'mcp-session-id': sessionId, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION },
    );
    expect(list.status).toBe(200);
    expect(readRpc(list).result.tools.length).toBe(55);
  });

  it('rejects a request with no session ID', async () => {
    const app = await buildApp({ MCP_STATELESS: 'false' });
    const res = await post(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.status).toBe(400);
  });
});

describe('protocol version negotiation', () => {
  it('negotiates down to a version the client asked for', async () => {
    const app = await buildApp();
    const res = await post(app, {
      ...INITIALIZE,
      params: { ...INITIALIZE.params, protocolVersion: '2025-06-18' },
    });
    expect(readRpc(res).result.protocolVersion).toBe('2025-06-18');
  });

  it('rejects an unsupported MCP-Protocol-Version header with 400', async () => {
    const app = await buildApp();
    const res = await post(
      app,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { 'mcp-protocol-version': '1999-01-01' },
    );
    expect(res.status).toBe(400);
  });
});

describe('Origin validation', () => {
  it('rejects a disallowed Origin with 403', async () => {
    const app = await buildApp({ MCP_ALLOWED_ORIGINS: 'https://app.example.com' });
    const res = await post(app, INITIALIZE, { Origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('allows a listed Origin and echoes it back', async () => {
    const app = await buildApp({ MCP_ALLOWED_ORIGINS: 'https://app.example.com' });
    const res = await post(app, INITIALIZE, { Origin: 'https://app.example.com' });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
  });

  it('allows any Origin when no allowlist is configured', async () => {
    const app = await buildApp();
    const res = await post(app, INITIALIZE, { Origin: 'https://anywhere.example.com' });
    expect(res.status).toBe(200);
  });
});

describe('initialize result metadata', () => {
  it('advertises tools, logging, and server identity', async () => {
    const app = await buildApp();
    const rpc = readRpc(await post(app, INITIALIZE));

    expect(rpc.result.capabilities.tools).toEqual({ listChanged: false });
    expect(rpc.result.capabilities.logging).toEqual({});
    expect(rpc.result.serverInfo.title).toBe('Starlink Enterprise');
    expect(rpc.result.serverInfo.websiteUrl).toBeTruthy();
    expect(rpc.result.serverInfo.description).toContain('Starlink');
    expect(rpc.result.instructions).toContain('Starlink Enterprise v2 API');
  });

  it('omits the tasks capability unless MCP_TASKS is on', async () => {
    const app = await buildApp();
    const rpc = readRpc(await post(app, INITIALIZE));
    expect(rpc.result.capabilities.tasks).toBeUndefined();
  });

  it('advertises icons when MCP_ICON_URL is set', async () => {
    const app = await buildApp({ MCP_ICON_URL: 'https://cdn.example.com/starlink.png' });
    const rpc = readRpc(await post(app, INITIALIZE));
    expect(rpc.result.serverInfo.icons).toEqual([
      { src: 'https://cdn.example.com/starlink.png', sizes: ['any'], mimeType: 'image/png' },
    ]);
  });
});

describe('logging capability', () => {
  it('accepts logging/setLevel', async () => {
    const app = await buildApp();
    const res = await post(app, {
      jsonrpc: '2.0',
      id: 5,
      method: 'logging/setLevel',
      params: { level: 'debug' },
    });
    expect(readRpc(res).error).toBeUndefined();
  });
});
