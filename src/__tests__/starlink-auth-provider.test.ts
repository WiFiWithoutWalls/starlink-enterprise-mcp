import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import axios from 'axios';
import { StarlinkAuthProvider } from '../auth/starlink-auth-provider.js';

vi.mock('axios');

const TOKEN_URL = 'https://www.starlink.com/api/auth/connect/token';

// ── Fake Express req/res ──

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: '',
    redirectedTo: undefined as string | undefined,
    cookies: [] as string[],
    status(c: number) { this.statusCode = c; return this; },
    type() { return this; },
    send(b: string) { this.body = b; return this; },
    redirect(url: string) { this.redirectedTo = url; return this; },
    append(_h: string, v: string | string[]) {
      const vals = Array.isArray(v) ? v : [v];
      this.cookies.push(...vals);
      return this;
    },
  };
  return res;
}

/** Pull "name=value" pairs out of Set-Cookie headers into a Cookie header string. */
function cookieHeaderFrom(res: any): string {
  return res.cookies
    .map((c: string) => c.split(';')[0])
    .filter((c: string) => !c.endsWith('=')) // skip cleared cookies
    .join('; ');
}

function fakeReq(cookieHeader: string) {
  return { headers: { cookie: cookieHeader } } as any;
}

const CLIENT = { client_id: 'mcp-client-1' } as any;
const PARAMS = {
  codeChallenge: 'challenge-xyz',
  redirectUri: 'https://app.example.com/callback',
  state: 'state-1',
  scopes: [],
} as any;

let storePath: string;
let provider: StarlinkAuthProvider;

beforeEach(() => {
  process.env.MCP_SESSION_SECRET = 'test-secret-at-least-16-chars-long';
  process.env.MCP_PERSISTENCE = 'file';
  delete process.env.GOOGLE_CLOUD_PROJECT;
  storePath = join(tmpdir(), `starlink-auth-test-${Date.now()}-${Math.floor(performance.now())}.json`);
  provider = new StarlinkAuthProvider({ tokenUrl: TOKEN_URL, tokenStorePath: storePath, tokenLifetimeSec: 3600 });
  vi.mocked(axios.post).mockReset();
});

afterEach(() => {
  try { rmSync(storePath); } catch { /* ignore */ }
});

/** Run authorize → handleLogin and return the issued auth code. */
async function loginAndGetCode(): Promise<string> {
  const res1 = fakeRes();
  await provider.authorize(CLIENT, PARAMS, res1);
  const cookie = cookieHeaderFrom(res1);

  vi.mocked(axios.post).mockResolvedValue({
    data: { access_token: 'sl-token-1', expires_in: 900 },
  } as any);

  const res2 = fakeRes();
  await provider.handleLogin(fakeReq(cookie), res2, 'sa-client', 'sa-secret');
  expect(res2.redirectedTo).toBeDefined();
  return new URL(res2.redirectedTo!).searchParams.get('code')!;
}

describe('StarlinkAuthProvider login', () => {
  it('renders a login page asking for Client ID and Client Secret', async () => {
    const res = fakeRes();
    await provider.authorize(CLIENT, PARAMS, res);
    expect(res.body).toContain('Client ID');
    expect(res.body).toContain('Client Secret');
    expect(res.body).toContain('Service Account');
  });

  it('validates service-account creds via client_credentials and issues a code', async () => {
    const code = await loginAndGetCode();
    expect(code).toMatch(/^[a-f0-9]{64}$/);

    // It ran the client_credentials grant.
    const [url, body] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    expect(String(body)).toContain('grant_type=client_credentials');
  });

  it('re-renders the login page with an error on bad credentials', async () => {
    const res1 = fakeRes();
    await provider.authorize(CLIENT, PARAMS, res1);
    const cookie = cookieHeaderFrom(res1);

    vi.mocked(axios.post).mockRejectedValue({ response: { status: 400, data: { error: 'invalid_client' } }, message: '400' });

    const res2 = fakeRes();
    await provider.handleLogin(fakeReq(cookie), res2, 'bad', 'creds');
    expect(res2.redirectedTo).toBeUndefined();
    expect(res2.body).toContain('Invalid service account credentials');
  });

  it('fails when there is no pending-auth cookie', async () => {
    const res = fakeRes();
    await provider.handleLogin(fakeReq(''), res, 'c', 's');
    expect(res.statusCode).toBe(440);
    expect(res.redirectedTo).toBeUndefined();
  });
});

describe('StarlinkAuthProvider single-account mode (operator default creds)', () => {
  it('skips the login page and auto-logs-in with operator credentials', async () => {
    const sa = new StarlinkAuthProvider({
      tokenUrl: TOKEN_URL,
      tokenStorePath: storePath,
      defaultClientId: 'operator-id',
      defaultClientSecret: 'operator-secret',
    });

    vi.mocked(axios.post).mockResolvedValue({ data: { access_token: 'sl-shared', expires_in: 900 } } as any);

    const res = fakeRes();
    await sa.authorize(CLIENT, PARAMS, res);

    // No login form rendered — straight to a redirect with an auth code.
    expect(res.body).toBe('');
    expect(res.redirectedTo).toBeDefined();
    const code = new URL(res.redirectedTo!).searchParams.get('code')!;

    // It used the operator credentials for the grant.
    const [, body] = vi.mocked(axios.post).mock.calls[0];
    expect(String(body)).toContain('client_id=operator-id');

    const tokens = await sa.exchangeAuthorizationCode(CLIENT, code);
    const info = await sa.verifyAccessToken(tokens.access_token);
    expect((info.extra as any).starlinkAccessToken).toBe('sl-shared');
  });

  it('falls back to the login form if operator credentials are bad', async () => {
    const sa = new StarlinkAuthProvider({
      tokenUrl: TOKEN_URL,
      tokenStorePath: storePath,
      defaultClientId: 'bad',
      defaultClientSecret: 'bad',
    });
    vi.mocked(axios.post).mockRejectedValue({ response: { status: 401, data: { error: 'invalid_client' } }, message: '401' });

    const res = fakeRes();
    await sa.authorize(CLIENT, PARAMS, res);
    // No redirect; the login form is shown instead of hard-failing.
    expect(res.redirectedTo).toBeUndefined();
    expect(res.body).toContain('Client ID');
  });
});

describe('StarlinkAuthProvider token exchange + verify', () => {
  it('exchanges an auth code for MCP tokens and verifies them', async () => {
    const code = await loginAndGetCode();

    expect(await provider.challengeForAuthorizationCode(CLIENT, code)).toBe('challenge-xyz');

    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.token_type).toBe('Bearer');

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe('mcp-client-1');
    expect((info.extra as any).starlinkAccessToken).toBe('sl-token-1');
  });

  it('re-mints the upstream token during verify when it is near expiry', async () => {
    // Log in with an upstream token that is already inside the refresh skew.
    const res1 = fakeRes();
    await provider.authorize(CLIENT, PARAMS, res1);
    const cookie = cookieHeaderFrom(res1);
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { access_token: 'sl-old', expires_in: 10 } } as any);
    const res2 = fakeRes();
    await provider.handleLogin(fakeReq(cookie), res2, 'sa', 'secret');
    const code = new URL(res2.redirectedTo!).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    // verify should re-mint via the stored service-account creds.
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { access_token: 'sl-new', expires_in: 900 } } as any);
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect((info.extra as any).starlinkAccessToken).toBe('sl-new');
  });

  it('refreshes by re-running client_credentials (no upstream refresh token)', async () => {
    const code = await loginAndGetCode();
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    vi.mocked(axios.post).mockResolvedValueOnce({ data: { access_token: 'sl-token-2', expires_in: 900 } } as any);
    const refreshed = await provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!);
    expect(refreshed.access_token).toBeDefined();
    expect(refreshed.access_token).not.toBe(tokens.access_token);

    const info = await provider.verifyAccessToken(refreshed.access_token);
    expect((info.extra as any).starlinkAccessToken).toBe('sl-token-2');
  });

  it('revokes a token so it no longer verifies', async () => {
    const code = await loginAndGetCode();
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);
    await provider.revokeToken(CLIENT, { token: tokens.access_token } as any);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow(/Invalid access token/);
  });
});
