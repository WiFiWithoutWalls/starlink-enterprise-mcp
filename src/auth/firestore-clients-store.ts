/**
 * Firestore-backed OAuth clients store.
 *
 * Persists DCR-registered clients so that container restarts and Cloud Run
 * instance switches don't invalidate previously-registered MCP clients
 * (which would otherwise force Claude/ChatGPT through DCR + login again).
 */

import { Firestore } from '@google-cloud/firestore';
import { randomUUID, randomBytes } from 'node:crypto';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { logger } from '../utils/logger.js';

export class FirestoreClientsStore implements OAuthRegisteredClientsStore {
  private cache = new Map<string, OAuthClientInformationFull>();
  private readonly db: Firestore;
  private readonly collection: string;

  constructor(opts: { collection?: string; projectId?: string } = {}) {
    this.collection = opts.collection ?? 'mcp_oauth_clients';
    this.db = new Firestore({ projectId: opts.projectId });
    logger.info('Firestore clients store initialized', { collection: this.collection });
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const hit = this.cache.get(clientId);
    if (hit) return hit;
    const snap = await this.db.collection(this.collection).doc(clientId).get();
    if (!snap.exists) return undefined;
    const client = snap.data() as OAuthClientInformationFull;
    this.cache.set(clientId, client);
    return client;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const clientId = randomUUID();
    const authMethod = (client as { token_endpoint_auth_method?: string }).token_endpoint_auth_method;
    const isPublic = authMethod === 'none';
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    if (!isPublic) {
      full.client_secret = randomBytes(32).toString('hex');
    }
    try {
      // Firestore rejects documents containing `undefined` values, which DCR
      // payloads commonly include for omitted optional fields. Strip them.
      await this.db.collection(this.collection).doc(clientId).set(stripUndefined(full));
      this.cache.set(clientId, full);
      return full;
    } catch (err: any) {
      logger.error('FirestoreClientsStore.registerClient failed', {
        error: err?.message ?? String(err),
        code: err?.code,
        details: err?.details,
      });
      throw err;
    }
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
