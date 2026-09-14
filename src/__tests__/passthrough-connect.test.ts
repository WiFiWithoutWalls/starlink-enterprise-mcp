/**
 * Regression tests for the three defects that stopped an MCP client from
 * connecting in pass-through mode:
 *
 *   1. /register stayed advertised and open, so a client that prefers dynamic
 *      registration got a client_id that can never authenticate upstream.
 *   2. The token endpoint read client_secret only from the form body, so a
 *      client using HTTP Basic was told its secret was missing.
 *   3. A client negotiating a protocol revision newer than this build was
 *      rejected outright instead of being clamped to the newest supported.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import axios from 'axios';
import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createApp, parseBasicAuth, negotiateProtocolVersion, rewriteRawHeader } from '../http-server.js';

vi.mock('axios');

const SA_ID = 'service-account-id';
const SA_SECRET = 'spx_test_secret';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let passthroughApp: Express;
let dcrApp: Express;

beforeAll(async () => {
  process.env.MCP_TRANSPORT = 'http';
  process.env.MCP_PERSISTENCE = 'file';
  process.env.MCP_SESSION_SECRET = 'test-secret-at-least-16-chars-long';
  process.env.MCP_BASE_URL = 'http://localhost:3000';
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.STARLINK_CLIENT_ID;
  delete process.env.STARLINK_CLIENT_SECRET;

  process.env.MCP_AUTH_MODE = 'passthrough';
  passthroughApp = (await createApp()).app;

  delete process.env.MCP_AUTH_MODE;
  dcrApp = (await createApp()).app;

  process.env.MCP_AUTH_MODE = 'passthrough';
});

beforeEach(() => {
  vi.mocked(axios.post).mockReset();
});

function pkce() {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Run /authorize and return the issued code. Pass-through skips the login page. */
async function getCode(app: Express, clientId: string, challenge: string): Promise<string> {
  const res = await request(app).get('/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'test-state',
  });
  expect(res.status).toBe(302);
  const code = new URL(res.headers.location).searchParams.get('code');
  expect(code).toBeTruthy();
  return code!;
}

describe('pass-through mode does not offer dynamic registration', () => {
  it('omits registration_endpoint from authorization-server metadata', async () => {
    const res = await request(passthroughApp).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.registration_endpoint).toBeUndefined();
  });

  it('serves no /register route', async () => {
    const res = await request(passthroughApp)
      .post('/register')
      .send({ client_name: 'probe', redirect_uris: [REDIRECT] });
    expect(res.status).toBe(404);
  });

  it('still offers registration when not in pass-through mode', async () => {
    const meta = await request(dcrApp).get('/.well-known/oauth-authorization-server');
    expect(meta.body.registration_endpoint).toContain('/register');

    const reg = await request(dcrApp)
      .post('/register')
      .send({
        client_name: 'probe',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      });
    expect(reg.status).toBe(201);
    expect(reg.body.client_id).toBeTruthy();
  });
});

describe('token endpoint accepts either client authentication method', () => {
  function mockStarlinkMint() {
    vi.mocked(axios.post).mockResolvedValue({
      data: { access_token: 'starlink-bearer', expires_in: 3600, token_type: 'Bearer' },
    } as never);
  }

  it('mints a session when the secret arrives as client_secret_post', async () => {
    mockStarlinkMint();
    const { verifier, challenge } = pkce();
    const code = await getCode(passthroughApp, SA_ID, challenge);

    const res = await request(passthroughApp).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: SA_ID,
      client_secret: SA_SECRET,
    });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });

  it('mints a session when the secret arrives as HTTP Basic', async () => {
    mockStarlinkMint();
    const { verifier, challenge } = pkce();
    const code = await getCode(passthroughApp, SA_ID, challenge);

    const basic = Buffer.from(`${SA_ID}:${SA_SECRET}`).toString('base64');
    const res = await request(passthroughApp)
      .post('/token')
      .set('Authorization', `Basic ${basic}`)
      .type('form')
      // Deliberately no client_id/client_secret in the body: the header is the
      // only source, which is exactly what used to fail.
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });

  it('forwards the Basic-supplied credentials upstream, not a placeholder', async () => {
    mockStarlinkMint();
    const { verifier, challenge } = pkce();
    const code = await getCode(passthroughApp, SA_ID, challenge);
    const basic = Buffer.from(`${SA_ID}:${SA_SECRET}`).toString('base64');

    await request(passthroughApp)
      .post('/token')
      .set('Authorization', `Basic ${basic}`)
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });

    const sentBody = vi.mocked(axios.post).mock.calls[0]?.[1];
    const sent = new URLSearchParams(sentBody as string);
    expect(sent.get('client_id')).toBe(SA_ID);
    expect(sent.get('client_secret')).toBe(SA_SECRET);
  });

  it('still rejects a token request carrying no secret at all', async () => {
    const { verifier, challenge } = pkce();
    const code = await getCode(passthroughApp, SA_ID, challenge);

    const res = await request(passthroughApp).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: SA_ID,
    });

    expect(res.status).toBe(400);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('parseBasicAuth', () => {
  it('decodes a credential pair', () => {
    const header = `Basic ${Buffer.from('id:secret').toString('base64')}`;
    expect(parseBasicAuth(header)).toEqual({ clientId: 'id', clientSecret: 'secret' });
  });

  it('is case-insensitive on the scheme', () => {
    const header = `basic ${Buffer.from('id:secret').toString('base64')}`;
    expect(parseBasicAuth(header)?.clientId).toBe('id');
  });

  it('form-decodes each half per RFC 6749', () => {
    const header = `Basic ${Buffer.from('a%40b:s%3Ap').toString('base64')}`;
    expect(parseBasicAuth(header)).toEqual({ clientId: 'a@b', clientSecret: 's:p' });
  });

  it('keeps everything after the first colon as the secret', () => {
    const header = `Basic ${Buffer.from('id:se:cret').toString('base64')}`;
    expect(parseBasicAuth(header)?.clientSecret).toBe('se:cret');
  });

  it('returns undefined for a bearer header, junk, or nothing', () => {
    expect(parseBasicAuth('Bearer abc')).toBeUndefined();
    expect(parseBasicAuth(`Basic ${Buffer.from('no-colon').toString('base64')}`)).toBeUndefined();
    expect(parseBasicAuth(undefined)).toBeUndefined();
  });
});

describe('negotiateProtocolVersion', () => {
  it('clamps a revision newer than this build to the newest supported', () => {
    expect(negotiateProtocolVersion('2026-07-28')).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('passes every supported revision through untouched', () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion(v)).toBe(v);
    }
  });

  it('leaves an unknown older revision alone so it still fails loudly', () => {
    expect(negotiateProtocolVersion('2023-01-01')).toBe('2023-01-01');
  });

  it('returns undefined when no version was requested', () => {
    expect(negotiateProtocolVersion(undefined)).toBeUndefined();
  });
});

describe('a future protocol revision reaches the transport clamped', () => {
  const FUTURE = '2026-07-28';

  async function bearer(): Promise<string> {
    vi.mocked(axios.post).mockResolvedValue({
      data: { access_token: 'starlink-bearer', expires_in: 3600, token_type: 'Bearer' },
    } as never);
    const { verifier, challenge } = pkce();
    const code = await getCode(passthroughApp, SA_ID, challenge);
    const res = await request(passthroughApp).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: SA_ID,
      client_secret: SA_SECRET,
    });
    expect(res.status).toBe(200);
    return res.body.access_token as string;
  }

  it('serves tools/list instead of 400ing on the version', async () => {
    const token = await bearer();
    const res = await request(passthroughApp)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('MCP-Protocol-Version', FUTURE)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Unsupported protocol version');
    expect(res.text).toContain('inputSchema');
  });

  it('still refuses an unknown older revision', async () => {
    const token = await bearer();
    const res = await request(passthroughApp)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('MCP-Protocol-Version', '2023-01-01')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('Unsupported protocol version');
  });
});

describe('rewriteRawHeader', () => {
  it('replaces the value for a header regardless of its case', () => {
    const raw = ['Host', 'x', 'MCP-Protocol-Version', '2026-07-28'];
    rewriteRawHeader(raw, 'mcp-protocol-version', '2025-11-25');
    expect(raw).toEqual(['Host', 'x', 'MCP-Protocol-Version', '2025-11-25']);
  });

  it('leaves other headers and a missing header alone', () => {
    const raw = ['Host', 'x'];
    rewriteRawHeader(raw, 'mcp-protocol-version', '2025-11-25');
    expect(raw).toEqual(['Host', 'x']);
    expect(() => rewriteRawHeader(undefined, 'a', 'b')).not.toThrow();
  });
});
