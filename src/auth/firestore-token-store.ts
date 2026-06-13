/**
 * Firestore-backed token store.
 *
 * Same shape as the file-backed TokenStore so the auth provider doesn't care
 * which one is in use. Tokens survive deploys, scaling events, and instance
 * switches on Cloud Run because Firestore is external to the container.
 *
 * Collection layout:
 *   {collection}/{accessToken}             — token document
 *   {collection}_refresh/{refreshToken}    — refresh-token → accessToken pointer
 *
 * We keep an in-memory mirror of recently-seen tokens to avoid a Firestore
 * round-trip on every MCP request. Writes go to Firestore first, then update
 * the cache. Reads check the cache, then Firestore on miss.
 */

import { Firestore } from '@google-cloud/firestore';
import type { StoredToken } from './token-store.js';
import { logger } from '../utils/logger.js';

export class FirestoreTokenStore {
  private cache = new Map<string, StoredToken>();
  private refreshCache = new Map<string, string>(); // refreshToken -> accessToken
  private readonly db: Firestore;
  private readonly collection: string;
  private readonly refreshCollection: string;

  constructor(opts: { collection?: string; projectId?: string } = {}) {
    this.collection = opts.collection ?? 'mcp_tokens';
    this.refreshCollection = `${this.collection}_refresh`;
    this.db = new Firestore({ projectId: opts.projectId });
    logger.info('Firestore token store initialized', {
      collection: this.collection,
      projectId: opts.projectId,
    });
  }

  async get(accessToken: string): Promise<StoredToken | undefined> {
    const hit = this.cache.get(accessToken);
    if (hit) return hit;
    const snap = await this.db.collection(this.collection).doc(accessToken).get();
    if (!snap.exists) return undefined;
    const data = snap.data() as StoredToken;
    this.cache.set(accessToken, data);
    this.refreshCache.set(data.refreshToken, accessToken);
    return data;
  }

  async getByRefreshToken(refreshToken: string): Promise<StoredToken | undefined> {
    const cachedAccess = this.refreshCache.get(refreshToken);
    if (cachedAccess) {
      const hit = this.cache.get(cachedAccess);
      if (hit) return hit;
    }
    const ptr = await this.db.collection(this.refreshCollection).doc(refreshToken).get();
    if (!ptr.exists) return undefined;
    const { accessToken } = ptr.data() as { accessToken: string };
    return this.get(accessToken);
  }

  async set(token: StoredToken): Promise<void> {
    const batch = this.db.batch();
    batch.set(this.db.collection(this.collection).doc(token.accessToken), stripUndefined(token));
    batch.set(this.db.collection(this.refreshCollection).doc(token.refreshToken), {
      accessToken: token.accessToken,
    });
    await batch.commit();
    this.cache.set(token.accessToken, token);
    this.refreshCache.set(token.refreshToken, token.accessToken);
  }

  async update(accessToken: string, patch: Partial<StoredToken>): Promise<StoredToken | undefined> {
    const existing = await this.get(accessToken);
    if (!existing) return undefined;
    const updated: StoredToken = { ...existing, ...patch };

    const batch = this.db.batch();
    batch.set(this.db.collection(this.collection).doc(updated.accessToken), stripUndefined(updated));
    if (patch.refreshToken && patch.refreshToken !== existing.refreshToken) {
      batch.delete(this.db.collection(this.refreshCollection).doc(existing.refreshToken));
      this.refreshCache.delete(existing.refreshToken);
    }
    batch.set(this.db.collection(this.refreshCollection).doc(updated.refreshToken), {
      accessToken: updated.accessToken,
    });
    await batch.commit();

    this.cache.set(updated.accessToken, updated);
    this.refreshCache.set(updated.refreshToken, updated.accessToken);
    return updated;
  }

  async delete(accessToken: string): Promise<void> {
    const existing = this.cache.get(accessToken) ?? (await this.get(accessToken));
    if (!existing) return;
    const batch = this.db.batch();
    batch.delete(this.db.collection(this.collection).doc(accessToken));
    batch.delete(this.db.collection(this.refreshCollection).doc(existing.refreshToken));
    await batch.commit();
    this.cache.delete(accessToken);
    this.refreshCache.delete(existing.refreshToken);
  }

  async deleteByRefreshToken(refreshToken: string): Promise<void> {
    const accessToken =
      this.refreshCache.get(refreshToken) ??
      ((await this.db.collection(this.refreshCollection).doc(refreshToken).get()).data() as
        | { accessToken?: string }
        | undefined)?.accessToken;
    if (!accessToken) return;
    await this.delete(accessToken);
  }

  get size(): number {
    return this.cache.size;
  }
}

function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
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
