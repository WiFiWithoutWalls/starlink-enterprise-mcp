import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { StarlinkClient } from '../starlink-client.js';

vi.mock('axios');

const API_URL = 'https://web-api.starlink.com';
const TOKEN_URL = 'https://www.starlink.com/api/auth/connect/token';

function createMockAxios() {
  const request = vi.fn();
  const mockInstance = { request } as unknown as AxiosInstance;
  vi.mocked(axios.create).mockReturnValue(mockInstance);
  return { mockInstance, request };
}

describe('StarlinkClient', () => {
  beforeEach(() => {
    vi.mocked(axios.create).mockReset();
    vi.mocked(axios.post).mockReset();
  });

  it('creates an axios instance with the API base URL and default timeout', () => {
    createMockAxios();
    new StarlinkClient({ apiUrl: API_URL, tokenUrl: TOKEN_URL, accessToken: 'tok' });
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: API_URL, timeout: 30000 }),
    );
  });

  it('attaches a static bearer token and returns a success envelope', async () => {
    const { request } = createMockAxios();
    request.mockResolvedValue({ data: { accountNumber: 'ACC-1' } });

    const client = new StarlinkClient({ apiUrl: API_URL, tokenUrl: TOKEN_URL, accessToken: 'static-tok' });
    const res = await client.request({ method: 'GET', pathTemplate: '/public/v2/account' });

    expect(res).toEqual({ success: true, data: { accountNumber: 'ACC-1' } });
    const cfg = request.mock.calls[0][0] as any;
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe('/public/v2/account');
    expect(cfg.headers.Authorization).toBe('Bearer static-tok');
  });

  it('substitutes path params and forwards query params', async () => {
    const { request } = createMockAxios();
    request.mockResolvedValue({ data: {} });

    const client = new StarlinkClient({ apiUrl: API_URL, tokenUrl: TOKEN_URL, accessToken: 't' });
    await client.request({
      method: 'GET',
      pathTemplate: '/public/v2/service-lines/{serviceLineNumber}',
      pathParams: { serviceLineNumber: 'SL-123' },
      queryParams: { page: 0, limit: 50, skip: undefined },
    });

    const cfg = request.mock.calls[0][0] as any;
    expect(cfg.url).toBe('/public/v2/service-lines/SL-123');
    expect(cfg.params).toEqual({ page: 0, limit: 50 }); // undefined dropped
  });

  it('sends a body on POST but not on GET/DELETE', async () => {
    const { request } = createMockAxios();
    request.mockResolvedValue({ data: {} });

    const client = new StarlinkClient({ apiUrl: API_URL, tokenUrl: TOKEN_URL, accessToken: 't' });
    await client.request({ method: 'POST', pathTemplate: '/public/v2/contacts', body: { name: 'A' } });
    expect((request.mock.calls[0][0] as any).data).toEqual({ name: 'A' });

    request.mockClear();
    await client.request({ method: 'DELETE', pathTemplate: '/public/v2/contacts/{subjectId}', pathParams: { subjectId: 'x' } });
    expect((request.mock.calls[0][0] as any).data).toBeUndefined();
  });

  it('re-mints the token and retries once on a 401 (service-account mode)', async () => {
    const { request } = createMockAxios();
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { access_token: 'tok1', expires_in: 900 } } as any)
      .mockResolvedValueOnce({ data: { access_token: 'tok2', expires_in: 900 } } as any);
    request
      .mockRejectedValueOnce({ response: { status: 401, data: 'unauthorized' } })
      .mockResolvedValueOnce({ data: { ok: true } });

    const client = new StarlinkClient({ apiUrl: API_URL, tokenUrl: TOKEN_URL, clientId: 'c', clientSecret: 's' });
    const res = await client.request({ method: 'GET', pathTemplate: '/public/v2/account' });

    expect(res).toEqual({ success: true, data: { ok: true } });
    // Two mints: initial + after the 401 clear. Two API attempts.
    expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect((request.mock.calls[1][0] as any).headers.Authorization).toBe('Bearer tok2');
  });

  it('returns a failure envelope on a non-401 error', async () => {
    const { request } = createMockAxios();
    request.mockRejectedValue({ response: { status: 404, data: { message: 'not found' } } });

    const client = new StarlinkClient({ apiUrl: API_URL, tokenUrl: TOKEN_URL, accessToken: 't' });
    const res = await client.request({ method: 'GET', pathTemplate: '/public/v2/account' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('404');
    expect(res.error).toContain('not found');
  });
});
