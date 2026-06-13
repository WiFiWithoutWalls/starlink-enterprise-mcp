import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

let app: Express;

beforeAll(async () => {
  // HTTP mode needs no operator credentials — each user brings their own.
  process.env.MCP_TRANSPORT = 'http';
  process.env.MCP_PERSISTENCE = 'file';
  process.env.MCP_SESSION_SECRET = 'test-secret-at-least-16-chars-long';
  process.env.MCP_BASE_URL = 'http://localhost:3000';
  delete process.env.GOOGLE_CLOUD_PROJECT;
  const { createApp } = await import('../http-server.js');
  app = createApp().app;
});

describe('health check', () => {
  it('returns ok and server metadata without auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.apiUrl).toContain('starlink');
  });
});

describe('OAuth discovery', () => {
  it('serves authorization-server metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBeDefined();
    expect(res.body.authorization_endpoint).toContain('/authorize');
    expect(res.body.token_endpoint).toContain('/token');
  });

  it('serves protected-resource metadata at the root path', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toContain('/mcp');
    expect(Array.isArray(res.body.authorization_servers)).toBe(true);
  });
});

describe('MCP transport auth gating', () => {
  it('rejects /mcp without a bearer token', async () => {
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
  });

  it('rejects /mcp with an invalid bearer token', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
  });
});

describe('login form validation', () => {
  it('400s when clientId/clientSecret are missing', async () => {
    const res = await request(app).post('/login').send({});
    expect(res.status).toBe(400);
  });

  it('there is no /mfa route (service accounts skip MFA)', async () => {
    const res = await request(app).post('/mfa').send({ passcode: '123456' });
    expect(res.status).toBe(404);
  });
});
