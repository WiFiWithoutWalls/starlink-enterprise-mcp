/**
 * OAuth 2.1 Server Provider for the Starlink Enterprise MCP Server.
 *
 * This server is its own OAuth 2.1 authorization server: MCP clients (Claude,
 * ChatGPT) do a standard DCR + browser-redirect login. The difference from a
 * typical OAuth proxy is what the login page collects — Starlink has no
 * interactive OAuth and no MFA. Instead the user pastes a **V2 Service Account
 * Client ID + Client Secret**, which this server exchanges for a bearer via the
 * `client_credentials` grant. The credentials are entered in a page served by
 * *this* server and never pass through the MCP transport or LLM context.
 *
 * Starlink bearer tokens are short-lived (~15 min) and have no refresh token,
 * so the service-account credentials are stored alongside the issued MCP token
 * and re-exchanged to mint a fresh bearer when the old one nears expiry.
 *
 * Env vars consumed (all set by the server operator):
 *   STARLINK_TOKEN_URL  – OIDC token endpoint (default www.starlink.com/...)
 */

import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidTokenError, InvalidClientError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { TokenStore } from './token-store.js';
import type { StoredToken, TokenStoreLike } from './token-store.js';
import { FirestoreTokenStore } from './firestore-token-store.js';
import { FirestoreClientsStore } from './firestore-clients-store.js';
import { mintClientCredentialsToken } from './starlink-token-manager.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingAuthorization {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state?: string;
  scopes?: string[];
  resource?: URL;
  createdAt: number;
}

/** What we mint + remember for a logged-in Starlink service account. */
interface StarlinkSession {
  accessToken: string;
  expiresAt?: number;
  clientId: string;
  clientSecret: string;
}

// ---------------------------------------------------------------------------
// Signed cookie helpers — keep OAuth-flow state stateless across container
// restarts and Cloud Run instance switches.
// ---------------------------------------------------------------------------

let sessionSecret: string | null = null;
function getSessionSecret(): string {
  if (sessionSecret) return sessionSecret;
  const fromEnv = process.env.MCP_SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    sessionSecret = fromEnv;
  } else {
    sessionSecret = randomBytes(32).toString('hex');
    logger.warn('MCP_SESSION_SECRET not set; generated ephemeral signing key. Set this env var (>=16 chars) to keep login sessions valid across restarts and instances.');
  }
  return sessionSecret;
}

const PENDING_AUTH_COOKIE = 'mcp_pending_auth';

export function signValue<T>(payload: T, ttlSec: number): string {
  const data = { ...(payload as object), exp: Math.floor(Date.now() / 1000) + ttlSec };
  const json = Buffer.from(JSON.stringify(data));
  const b64 = json.toString('base64url');
  const sig = createHmac('sha256', getSessionSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

export function verifySigned<T>(token: string): T | null {
  try {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const b64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac('sha256', getSessionSecret()).update(b64).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (typeof data.exp === 'number' && data.exp < Math.floor(Date.now() / 1000)) return null;
    delete data.exp;
    return data as T;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSignedCookie(res: Response, name: string, value: string, maxAgeSec: number): void {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ];
  res.append('Set-Cookie', attrs.join('; '));
}

function clearCookie(res: Response, name: string): void {
  res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`);
}

// ---------------------------------------------------------------------------
// In-memory clients store (supports dynamic registration)
// ---------------------------------------------------------------------------

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const clientId = randomUUID();
    // Honor the client's requested authentication method. Public clients
    // (token_endpoint_auth_method=none) get no secret — they rely on PKCE
    // alone, which is correct for browser/native apps like ChatGPT.
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
    this.clients.set(clientId, full);
    return full;
  }
}

// ---------------------------------------------------------------------------
// Pass-through clients store
//
// In pass-through mode the MCP client (Claude) presents the Starlink
// service-account credentials AS its OAuth client_id + client_secret — there is
// no DCR and no login page. We synthesize a *public* client for any presented
// client_id (so the SDK's clientAuth doesn't compare a stored secret) and
// accumulate the redirect_uris seen at /authorize so the SDK's redirect check
// passes. The presented secret is validated against Starlink at /token, not here.
// ---------------------------------------------------------------------------

class DynamicClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  private synth(clientId: string, redirectUris: string[]): OAuthClientInformationFull {
    return {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    } as OAuthClientInformationFull;
  }

  getClient(clientId: string): OAuthClientInformationFull {
    return this.clients.get(clientId) ?? this.synth(clientId, []);
  }

  /** Record (and accumulate) a redirect_uri seen for a client at /authorize. */
  remember(clientId: string, redirectUri?: string): void {
    const existing = this.clients.get(clientId);
    const uris = new Set(existing?.redirect_uris ?? []);
    if (redirectUri) uris.add(redirectUri);
    this.clients.set(clientId, this.synth(clientId, [...uris]));
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const full = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    } as OAuthClientInformationFull;
    this.clients.set(full.client_id, full);
    return full;
  }
}

// ---------------------------------------------------------------------------
// Login page HTML
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function logoHtml(): string {
  const url = process.env.MCP_LOGIN_LOGO_URL || process.env.MCP_ICON_URL;
  if (!url) return '';
  return `<div class="logo"><img src="${escapeHtml(url)}" alt=""></div>`;
}

function loginPageHtml(authorizeUrl: string, error?: string): string {
  const errorHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : '';
  const heading = process.env.MCP_LOGIN_HEADER || 'Starlink MCP — Sign In';
  const safeHeading = escapeHtml(heading);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeHeading}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: #f5f5f5; display: flex; justify-content: center; align-items: center;
           min-height: 100vh; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.1);
            padding: 2rem; width: 100%; max-width: 420px; }
    .logo { text-align: center; margin-bottom: 1rem; }
    .logo img { max-width: 96px; max-height: 96px; height: auto; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; text-align: center; }
    .hint { font-size: 0.85rem; color: #555; text-align: center; margin-bottom: 1.25rem; }
    .hint a { color: #2563eb; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem; }
    input { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #ccc; border-radius: 4px;
            font-size: 0.9rem; margin-bottom: 1rem; }
    input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.2); }
    button { width: 100%; padding: 0.6rem; background: #2563eb; color: #fff; border: none;
             border-radius: 4px; font-size: 0.95rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca;
             border-radius: 4px; padding: 0.5rem 0.75rem; margin-bottom: 1rem; font-size: 0.85rem; }
    .footer { text-align: center; margin-top: 1rem; font-size: 0.75rem; color: #888; }
  </style>
</head>
<body>
  <div class="card">
    ${logoHtml()}
    <h1>${safeHeading}</h1>
    <div class="hint">Enter your Starlink <strong>V2 Service Account</strong> credentials. Create one in
      <a href="https://www.starlink.com/account/settings" target="_blank" rel="noreferrer">Account Settings → API V2 Service Accounts</a>.</div>
    ${errorHtml}
    <form method="POST" action="${escapeHtml(authorizeUrl)}">
      <label for="clientId">Client ID</label>
      <input type="text" id="clientId" name="clientId" required autocomplete="username" autofocus>
      <label for="clientSecret">Client Secret</label>
      <input type="password" id="clientSecret" name="clientSecret" required autocomplete="current-password">
      <button type="submit">Connect</button>
    </form>
    <div class="footer">Credentials are sent directly to the server, never to the AI.</div>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export interface StarlinkAuthProviderOptions {
  /** OIDC token endpoint for the client_credentials grant. */
  tokenUrl: string;
  /** MCP token lifetime in seconds (default 3600). */
  tokenLifetimeSec?: number;
  /** Path to the file-backed token store (default ~/.starlink-mcp/http-tokens.json). */
  tokenStorePath?: string;
  /**
   * Operator-configured service account. When BOTH are set, the authorize
   * flow skips the credential-entry page and auto-logs-in with these — a
   * single shared Starlink account for everyone who connects. When unset,
   * each user enters their own credentials on the login page (multi-tenant).
   */
  defaultClientId?: string;
  defaultClientSecret?: string;
  /**
   * Pass-through mode: the MCP client presents the Starlink service-account
   * credentials as its OAuth client_id + client_secret. No DCR, no login page;
   * the secret is validated against Starlink at /token. See DynamicClientsStore.
   */
  passthrough?: boolean;
}

export class StarlinkAuthProvider implements OAuthServerProvider {
  private _clientsStore: OAuthRegisteredClientsStore;
  private authCodes = new Map<string, { pending: PendingAuthorization; session?: StarlinkSession; passthrough?: boolean }>();
  /** Pass-through: client_secret presented at /token, keyed by auth code. */
  private pendingTokenSecrets = new Map<string, string>();
  private tokenStore: TokenStoreLike;

  private tokenUrl: string;
  private tokenLifetimeSec: number;
  private defaultClientId?: string;
  private defaultClientSecret?: string;
  private passthrough: boolean;

  /** Re-mint the upstream Starlink token when within this many ms of expiry. */
  private static readonly STARLINK_REFRESH_SKEW_MS = 60_000;

  constructor(options: StarlinkAuthProviderOptions) {
    this.tokenUrl = options.tokenUrl;
    this.tokenLifetimeSec = options.tokenLifetimeSec ?? 3600;
    this.defaultClientId = options.defaultClientId;
    this.defaultClientSecret = options.defaultClientSecret;
    this.passthrough = options.passthrough ?? false;

    const useFirestore =
      process.env.MCP_PERSISTENCE === 'firestore' ||
      (process.env.MCP_PERSISTENCE !== 'file' && !!process.env.GOOGLE_CLOUD_PROJECT);

    // Issued tokens always persist (Firestore on Cloud Run, file locally).
    this.tokenStore = useFirestore
      ? new FirestoreTokenStore({ projectId: process.env.GOOGLE_CLOUD_PROJECT })
      : new TokenStore(options.tokenStorePath);

    // Clients store: pass-through synthesizes clients on the fly; otherwise the
    // DCR-registered store (persisted on Firestore, in-memory locally).
    if (this.passthrough) {
      this._clientsStore = new DynamicClientsStore();
      logger.info('Auth provider in pass-through mode (client supplies Starlink credentials as OAuth client)');
    } else if (useFirestore) {
      this._clientsStore = new FirestoreClientsStore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
    } else {
      this._clientsStore = new InMemoryClientsStore();
    }
    logger.info('Auth provider persistence', { tokens: useFirestore ? 'firestore' : 'file', passthrough: this.passthrough });
  }

  // -----------------------------------------------------------------------
  // Pass-through hooks (called by the /authorize and /token middlewares)
  // -----------------------------------------------------------------------

  /** Record the redirect_uri presented for a client_id at /authorize. */
  rememberClient(clientId: string, redirectUri?: string): void {
    if (this._clientsStore instanceof DynamicClientsStore) {
      this._clientsStore.remember(clientId, redirectUri);
    }
  }

  /** Stash the client_secret presented at /token, keyed by the auth code. */
  captureTokenSecret(code: string, secret: string): void {
    this.pendingTokenSecrets.set(code, secret);
    setTimeout(() => this.pendingTokenSecrets.delete(code), 5 * 60 * 1000);
  }

  get activeTokenCount(): number {
    return this.tokenStore.size;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  // -----------------------------------------------------------------------
  // authorize — show login page; the POST is handled by handleLogin()
  // -----------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes: params.scopes,
      resource: params.resource,
      createdAt: Date.now(),
    };

    // Pass-through mode: the client_id IS the Starlink service account. We
    // don't have the secret yet (it arrives at /token), so just issue an auth
    // code and redirect — no login page, no credential validation here.
    if (this.passthrough) {
      const code = randomBytes(32).toString('hex');
      this.authCodes.set(code, { pending, passthrough: true });
      setTimeout(() => this.authCodes.delete(code), 5 * 60 * 1000);
      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set('code', code);
      if (pending.state) redirectUrl.searchParams.set('state', pending.state);
      res.redirect(redirectUrl.toString());
      return;
    }

    // Single-account mode: when the operator has configured a service account,
    // skip the credential-entry page and auto-log-in with it. The user never
    // sees a login form — the connector just works against the shared account.
    if (this.defaultClientId && this.defaultClientSecret) {
      try {
        const tokens = await mintClientCredentialsToken({
          tokenUrl: this.tokenUrl,
          clientId: this.defaultClientId,
          clientSecret: this.defaultClientSecret,
        });
        await this.completeLogin(
          pending,
          {
            accessToken: tokens.access_token,
            expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
            clientId: this.defaultClientId,
            clientSecret: this.defaultClientSecret,
          },
          res,
        );
        return;
      } catch (err: any) {
        // Misconfigured operator credentials — fall through to the login form
        // so a user can still enter their own rather than hard-failing.
        logger.error('Operator default service account failed; falling back to login form', {
          error: err.message,
        });
      }
    }

    const cookie = signValue(pending, 15 * 60); // 15 min TTL
    setSignedCookie(res, PENDING_AUTH_COOKIE, cookie, 15 * 60);

    res.status(200).type('html').send(loginPageHtml('/login'));
  }

  /**
   * Called by our custom POST /login route. Validates the entered Starlink
   * service-account credentials by running the client_credentials grant, then
   * issues an authorization code and redirects back to the MCP client.
   */
  async handleLogin(req: Request, res: Response, clientId: string, clientSecret: string): Promise<void> {
    const cookies = parseCookies(req.headers.cookie);
    const pending = cookies[PENDING_AUTH_COOKIE]
      ? verifySigned<PendingAuthorization>(cookies[PENDING_AUTH_COOKIE])
      : null;
    if (!pending) {
      res.status(440).type('html').send(
        loginPageHtml('/login', 'Your sign-in session has expired. Close this tab and reconnect from your MCP client to start over.'),
      );
      return;
    }

    let session: StarlinkSession;
    try {
      const tokens = await mintClientCredentialsToken({ tokenUrl: this.tokenUrl, clientId, clientSecret });
      session = {
        accessToken: tokens.access_token,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
        clientId,
        clientSecret,
      };
    } catch (err: any) {
      logger.warn('Starlink service-account login failed', { error: err.message });
      const msg = /4\d\d/.test(String(err.message))
        ? 'Invalid service account credentials. Check the Client ID and Client Secret.'
        : `Authentication failed: ${err.message}`;
      res.status(200).type('html').send(loginPageHtml('/login', msg));
      return;
    }

    clearCookie(res, PENDING_AUTH_COOKIE);
    await this.completeLogin(pending, session, res);
  }

  private async completeLogin(pending: PendingAuthorization, session: StarlinkSession, res: Response): Promise<void> {
    const code = randomBytes(32).toString('hex');
    this.authCodes.set(code, { pending, session });
    setTimeout(() => this.authCodes.delete(code), 5 * 60 * 1000);

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (pending.state) redirectUrl.searchParams.set('state', pending.state);
    res.redirect(redirectUrl.toString());
  }

  // -----------------------------------------------------------------------
  // Token exchange
  // -----------------------------------------------------------------------

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) throw new Error('Invalid authorization code');
    return entry.pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry) throw new InvalidGrantError('Invalid authorization code');
    this.authCodes.delete(authorizationCode);

    // Pass-through: the secret arrived at /token (captured by middleware). Mint
    // a Starlink token with the presented client_id + secret — a successful
    // grant IS the authentication. A failure means bad service-account creds.
    if (entry.passthrough) {
      const clientSecret = this.pendingTokenSecrets.get(authorizationCode);
      this.pendingTokenSecrets.delete(authorizationCode);
      if (!clientSecret) {
        throw new InvalidClientError('client_secret is required (pass-through mode)');
      }
      let tokens;
      try {
        tokens = await mintClientCredentialsToken({
          tokenUrl: this.tokenUrl,
          clientId: entry.pending.clientId,
          clientSecret,
        });
      } catch (err: any) {
        logger.warn('Pass-through credential validation failed', { error: err.message });
        throw new InvalidClientError('Invalid Starlink service account credentials');
      }
      const session: StarlinkSession = {
        accessToken: tokens.access_token,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
        clientId: entry.pending.clientId,
        clientSecret,
      };
      return this.issueTokens(entry.pending.clientId, session);
    }

    if (!entry.session) throw new InvalidGrantError('Invalid authorization code');
    return this.issueTokens(entry.pending.clientId, entry.session);
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const stored = await this.tokenStore.getByRefreshToken(refreshToken);
    if (!stored) throw new Error('Invalid refresh token');

    // Starlink has no refresh token — re-mint a fresh bearer from the stored
    // service-account credentials.
    let session: StarlinkSession;
    try {
      const tokens = await mintClientCredentialsToken({
        tokenUrl: this.tokenUrl,
        clientId: stored.starlinkClientId,
        clientSecret: stored.starlinkClientSecret,
      });
      session = {
        accessToken: tokens.access_token,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
        clientId: stored.starlinkClientId,
        clientSecret: stored.starlinkClientSecret,
      };
    } catch {
      throw new Error('Upstream token refresh failed. Please re-authenticate.');
    }

    await this.tokenStore.delete(stored.accessToken);
    return this.issueTokens(stored.clientId, session);
  }

  // -----------------------------------------------------------------------
  // Token verification
  // -----------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let stored = await this.tokenStore.get(token);
    if (!stored) throw new InvalidTokenError('Invalid access token');

    if (Date.now() > stored.expiresAt) {
      await this.tokenStore.delete(token);
      throw new InvalidTokenError('Access token expired');
    }

    // Transparently re-mint the upstream Starlink token if it has expired or is
    // within the skew window. The MCP client never sees this.
    const starlinkExpired =
      stored.starlinkExpiresAt &&
      Date.now() > stored.starlinkExpiresAt - StarlinkAuthProvider.STARLINK_REFRESH_SKEW_MS;
    if (starlinkExpired) {
      try {
        const tokens = await mintClientCredentialsToken({
          tokenUrl: this.tokenUrl,
          clientId: stored.starlinkClientId,
          clientSecret: stored.starlinkClientSecret,
        });
        const updated = await this.tokenStore.update(token, {
          starlinkAccessToken: tokens.access_token,
          starlinkExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
        });
        if (updated) stored = updated;
        logger.info('Re-minted upstream Starlink token');
      } catch (err) {
        logger.warn('Upstream Starlink token re-mint failed during verify; the API call may 401', {
          error: String(err),
        });
        // Fall through; the API call will 401 and the client will refresh.
      }
    }

    return {
      token,
      clientId: stored.clientId,
      scopes: [],
      expiresAt: Math.floor(stored.expiresAt / 1000),
      extra: {
        starlinkAccessToken: stored.starlinkAccessToken,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Revocation
  // -----------------------------------------------------------------------

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const { token } = request;
    const stored = await this.tokenStore.get(token);
    if (stored) {
      await this.tokenStore.delete(token);
      return;
    }
    const byRefresh = await this.tokenStore.getByRefreshToken(token);
    if (byRefresh) {
      await this.tokenStore.deleteByRefreshToken(token);
    }
  }

  // -----------------------------------------------------------------------
  // Lookup: get the upstream Starlink token for a verified MCP token
  // -----------------------------------------------------------------------

  async getStarlinkAccessToken(mcpToken: string): Promise<string | undefined> {
    const stored = await this.tokenStore.get(mcpToken);
    return stored?.starlinkAccessToken;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async issueTokens(clientId: string, session: StarlinkSession): Promise<OAuthTokens> {
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.tokenLifetimeSec * 1000;

    const stored: StoredToken = {
      accessToken,
      refreshToken,
      clientId,
      expiresAt,
      starlinkAccessToken: session.accessToken,
      starlinkExpiresAt: session.expiresAt,
      starlinkClientId: session.clientId,
      starlinkClientSecret: session.clientSecret,
    };

    await this.tokenStore.set(stored);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.tokenLifetimeSec,
      refresh_token: refreshToken,
    };
  }
}
