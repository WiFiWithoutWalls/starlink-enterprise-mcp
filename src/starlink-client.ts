/**
 * Starlink Enterprise API client.
 *
 * Implements the GenericApiClient contract used by the OpenAPI-generated tool
 * handlers in src/generated/. Attaches the right bearer to every request,
 * resolves path-template placeholders, strips empty query params, and returns
 * a uniform StarlinkApiResponse shape.
 *
 * Auth modes:
 *   - `accessToken` set  → use it directly (HTTP transport supplies a per-user
 *     token resolved from the OAuth session; re-minting is handled upstream).
 *   - `clientId`/`clientSecret` set → mint a bearer via client_credentials and
 *     re-mint transparently on expiry or a 401 (stdio operator mode).
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import type { StarlinkConfig } from './types/config.js';
import type { StarlinkApiResponse } from './generated/types.js';
import { StarlinkTokenManager } from './auth/starlink-token-manager.js';
import { logger } from './utils/logger.js';

export class StarlinkClient {
  private client: AxiosInstance;
  private config: StarlinkConfig;
  private tokenManager?: StarlinkTokenManager;
  private staticToken?: string;

  constructor(config: StarlinkConfig) {
    this.config = config;

    if (config.clientId && config.clientSecret) {
      this.tokenManager = new StarlinkTokenManager({
        tokenUrl: config.tokenUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });
    } else if (config.accessToken) {
      this.staticToken = config.accessToken;
    }

    this.client = axios.create({
      baseURL: config.apiUrl,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Starlink-Enterprise-MCP/1.0.0',
      },
    });
  }

  private async authHeader(): Promise<string | undefined> {
    if (this.tokenManager) {
      return `Bearer ${await this.tokenManager.getAccessToken()}`;
    }
    if (this.staticToken) {
      return `Bearer ${this.staticToken}`;
    }
    return undefined;
  }

  /**
   * Generic request — satisfies the GenericApiClient contract.
   *
   * Resolves {placeholders} in the path template, URL-encodes path params,
   * drops undefined query params, and (when minting our own token) retries once
   * on a 401 after re-minting — Starlink signals an expired/invalid bearer with
   * 401 and expects the caller to obtain a fresh token.
   */
  async request<T = unknown>(opts: {
    method: string;
    pathTemplate: string;
    pathParams?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    body?: unknown;
  }): Promise<StarlinkApiResponse<T>> {
    let url = opts.pathTemplate;
    if (opts.pathParams) {
      for (const [key, value] of Object.entries(opts.pathParams)) {
        if (value === undefined || value === null) continue;
        url = url.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(String(value)));
      }
    }

    const params: Record<string, unknown> = {};
    if (opts.queryParams) {
      for (const [key, value] of Object.entries(opts.queryParams)) {
        if (value !== undefined && value !== null) params[key] = value;
      }
    }

    const method = opts.method.toUpperCase();
    const send = async (): Promise<AxiosResponse> => {
      const headers: Record<string, string> = {};
      const auth = await this.authHeader();
      if (auth) headers.Authorization = auth;
      const reqConfig: any = { method, url, params, headers };
      if (method !== 'GET' && method !== 'DELETE') reqConfig.data = opts.body;
      return this.client.request(reqConfig);
    };

    try {
      const response = await send();
      return { success: true, data: response.data as T };
    } catch (error: any) {
      // Token expired/invalid — re-mint once and retry (only when we own the token).
      if (error.response?.status === 401 && this.tokenManager) {
        logger.info('Starlink API returned 401; re-minting token and retrying');
        this.tokenManager.clear();
        try {
          const retry = await send();
          return { success: true, data: retry.data as T };
        } catch (retryErr: any) {
          return { success: false, error: formatError(retryErr) };
        }
      }
      return { success: false, error: formatError(error) };
    }
  }
}

function formatError(error: any): string {
  const status = error.response?.status;
  const data = error.response?.data;
  const msg =
    (typeof data === 'object' && data && (data.errors || data.error_description || data.error || data.message)) ||
    (typeof data === 'string' ? data : undefined) ||
    error.message ||
    'request failed';
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  return status ? `${status} ${text}` : text;
}
