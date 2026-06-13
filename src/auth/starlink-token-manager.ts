/**
 * Starlink OAuth token minting (client_credentials grant).
 *
 * Starlink V2 service accounts authenticate machine-to-machine: a Client ID +
 * Client Secret are exchanged for a short-lived (~15 min) bearer token via the
 * OIDC `client_credentials` grant. There is no refresh token — when the bearer
 * expires (or a request returns 401) you re-run the grant with the same
 * credentials to mint a fresh one.
 *
 * Docs: https://starlink.readme.io/docs/authentication
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

export const DEFAULT_TOKEN_URL = 'https://www.starlink.com/api/auth/connect/token';

export interface StarlinkTokenResponse {
  access_token: string;
  token_type?: string;
  /** Lifetime in seconds. */
  expires_in?: number;
}

/**
 * Run the client_credentials grant once and return the raw token response.
 * Throws with a descriptive message on bad credentials / network failure.
 */
export async function mintClientCredentialsToken(opts: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<StarlinkTokenResponse> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'client_credentials',
  });

  try {
    const response = await axios.post(opts.tokenUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    });

    const accessToken = response.data?.access_token;
    if (!accessToken) {
      throw new Error('Token endpoint did not return an access_token');
    }
    return {
      access_token: accessToken,
      token_type: response.data?.token_type,
      expires_in: response.data?.expires_in,
    };
  } catch (err: any) {
    const status = err.response?.status;
    const data = err.response?.data;
    const detail =
      (typeof data === 'object' && data && (data.error_description || data.error)) ||
      (typeof data === 'string' ? data : undefined) ||
      err.message;
    const message = status ? `${status} — ${detail}` : String(detail);
    throw new Error(`Starlink token request failed: ${message}`);
  }
}

/**
 * Caches a client_credentials bearer for a single service account and re-mints
 * it transparently when it nears expiry. Used by the stdio client path; the
 * HTTP auth provider mints/persists tokens per user instead.
 */
export class StarlinkTokenManager {
  private tokenUrl: string;
  private clientId: string;
  private clientSecret: string;

  private accessToken: string | null = null;
  private expiresAt = 0; // epoch ms

  /** Re-mint when within this many ms of expiry. */
  private static readonly SKEW_MS = 60_000;
  /** Fallback lifetime if the token endpoint omits expires_in. */
  private static readonly DEFAULT_TTL_SEC = 900;

  constructor(opts: { tokenUrl: string; clientId: string; clientSecret: string }) {
    this.tokenUrl = opts.tokenUrl;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
  }

  /** Return a valid bearer, minting or re-minting as needed. */
  async getAccessToken(): Promise<string> {
    const fresh = this.accessToken && Date.now() < this.expiresAt - StarlinkTokenManager.SKEW_MS;
    if (fresh) return this.accessToken!;
    return this.mint();
  }

  /** Drop the cached token so the next call mints anew (call after a 401). */
  clear(): void {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  private async mint(): Promise<string> {
    const tokens = await mintClientCredentialsToken({
      tokenUrl: this.tokenUrl,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
    });
    const ttl = tokens.expires_in ?? StarlinkTokenManager.DEFAULT_TTL_SEC;
    this.accessToken = tokens.access_token;
    this.expiresAt = Date.now() + ttl * 1000;
    logger.info('Minted Starlink access token', { expiresInSec: ttl });
    return this.accessToken;
  }
}
