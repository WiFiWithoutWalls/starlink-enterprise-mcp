import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { mintClientCredentialsToken, StarlinkTokenManager } from '../auth/starlink-token-manager.js';

vi.mock('axios');

const TOKEN_URL = 'https://www.starlink.com/api/auth/connect/token';

describe('mintClientCredentialsToken', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it('posts a form-encoded client_credentials grant and returns the token', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { access_token: 'abc123', token_type: 'Bearer', expires_in: 900 },
    } as any);

    const result = await mintClientCredentialsToken({
      tokenUrl: TOKEN_URL,
      clientId: 'cid',
      clientSecret: 'secret',
    });

    expect(result.access_token).toBe('abc123');
    expect(result.expires_in).toBe(900);

    const [url, body, config] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    expect(String(body)).toContain('grant_type=client_credentials');
    expect(String(body)).toContain('client_id=cid');
    expect(String(body)).toContain('client_secret=secret');
    expect((config as any).headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('throws a descriptive error on bad credentials', async () => {
    vi.mocked(axios.post).mockRejectedValue({
      response: { status: 400, data: { error: 'invalid_client' } },
      message: 'Request failed',
    });

    await expect(
      mintClientCredentialsToken({ tokenUrl: TOKEN_URL, clientId: 'x', clientSecret: 'y' }),
    ).rejects.toThrow(/400 — invalid_client/);
  });

  it('throws when the response omits an access_token', async () => {
    vi.mocked(axios.post).mockResolvedValue({ data: {} } as any);
    await expect(
      mintClientCredentialsToken({ tokenUrl: TOKEN_URL, clientId: 'x', clientSecret: 'y' }),
    ).rejects.toThrow(/did not return an access_token/);
  });
});

describe('StarlinkTokenManager', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it('caches the token and only mints once while fresh', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { access_token: 'tok1', expires_in: 900 },
    } as any);

    const mgr = new StarlinkTokenManager({ tokenUrl: TOKEN_URL, clientId: 'c', clientSecret: 's' });
    expect(await mgr.getAccessToken()).toBe('tok1');
    expect(await mgr.getAccessToken()).toBe('tok1');
    expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(1);
  });

  it('re-mints after clear()', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { access_token: 'tok1', expires_in: 900 } } as any)
      .mockResolvedValueOnce({ data: { access_token: 'tok2', expires_in: 900 } } as any);

    const mgr = new StarlinkTokenManager({ tokenUrl: TOKEN_URL, clientId: 'c', clientSecret: 's' });
    expect(await mgr.getAccessToken()).toBe('tok1');
    mgr.clear();
    expect(await mgr.getAccessToken()).toBe('tok2');
    expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(2);
  });

  it('re-mints when the cached token is within the expiry skew', async () => {
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { access_token: 'tok1', expires_in: 30 } } as any) // < 60s skew
      .mockResolvedValueOnce({ data: { access_token: 'tok2', expires_in: 900 } } as any);

    const mgr = new StarlinkTokenManager({ tokenUrl: TOKEN_URL, clientId: 'c', clientSecret: 's' });
    expect(await mgr.getAccessToken()).toBe('tok1');
    // expires_in=30 is inside the 60s skew window, so the next call re-mints.
    expect(await mgr.getAccessToken()).toBe('tok2');
    expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(2);
  });
});
