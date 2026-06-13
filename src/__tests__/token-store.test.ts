import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { TokenStore, type StoredToken } from '../auth/token-store.js';

let path: string;

function sample(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    accessToken: 'acc-1',
    refreshToken: 'ref-1',
    clientId: 'mcp-client',
    expiresAt: Date.now() + 3_600_000,
    starlinkAccessToken: 'sl-1',
    starlinkExpiresAt: Date.now() + 900_000,
    starlinkClientId: 'sa-id',
    starlinkClientSecret: 'sa-secret',
    ...overrides,
  };
}

beforeEach(() => {
  path = join(tmpdir(), `starlink-token-store-${Date.now()}-${Math.floor(performance.now())}.json`);
});
afterEach(() => {
  try { rmSync(path); } catch { /* ignore */ }
});

describe('TokenStore', () => {
  it('stores and retrieves by access and refresh token', () => {
    const store = new TokenStore(path);
    const tok = sample();
    store.set(tok);
    expect(store.get('acc-1')).toEqual(tok);
    expect(store.getByRefreshToken('ref-1')).toEqual(tok);
    expect(store.size).toBe(1);
  });

  it('updates in place and re-indexes a rotated refresh token', () => {
    const store = new TokenStore(path);
    store.set(sample());
    const updated = store.update('acc-1', { starlinkAccessToken: 'sl-2', refreshToken: 'ref-2' });
    expect(updated?.starlinkAccessToken).toBe('sl-2');
    expect(store.getByRefreshToken('ref-1')).toBeUndefined();
    expect(store.getByRefreshToken('ref-2')?.accessToken).toBe('acc-1');
  });

  it('deletes by access and by refresh token', () => {
    const store = new TokenStore(path);
    store.set(sample());
    store.delete('acc-1');
    expect(store.get('acc-1')).toBeUndefined();

    store.set(sample({ accessToken: 'acc-2', refreshToken: 'ref-2' }));
    store.deleteByRefreshToken('ref-2');
    expect(store.get('acc-2')).toBeUndefined();
  });

  it('persists across instances (survives a restart)', () => {
    const store = new TokenStore(path);
    store.set(sample());
    const reopened = new TokenStore(path);
    expect(reopened.get('acc-1')?.starlinkClientId).toBe('sa-id');
  });

  it('cleanup removes expired tokens', () => {
    const store = new TokenStore(path);
    store.set(sample({ accessToken: 'expired', refreshToken: 'r-exp', expiresAt: Date.now() - 1000 }));
    store.set(sample({ accessToken: 'live', refreshToken: 'r-live' }));
    store.cleanup();
    expect(store.get('expired')).toBeUndefined();
    expect(store.get('live')).toBeDefined();
  });
});
