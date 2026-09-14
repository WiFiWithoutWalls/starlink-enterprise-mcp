/**
 * HTTP transport for the Starlink Enterprise MCP Server.
 *
 * Runs an Express app that serves:
 *   - OAuth 2.1 authorization endpoints (login page, token exchange)
 *   - MCP Streamable HTTP transport at /mcp (bearer-auth gated)
 *   - Health check at /health
 *
 * Each user signs in with their own Starlink V2 service-account credentials on
 * the hosted login page; the verified per-user Starlink bearer is attached to
 * that session's tool calls.
 *
 * The transport runs stateless by default (see `statelessEnabled`).
 */

import { randomUUID, createHash } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js';
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/index.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { createMcpServer, loadConfig } from './index.js';
import { StarlinkAuthProvider } from './auth/starlink-auth-provider.js';
import { createTaskStore } from './tasks/index.js';
import { logger } from './utils/logger.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

interface AuthenticatedRequest extends IncomingMessage {
  auth?: AuthInfo;
  body?: unknown;
}

/**
 * Stateless mode: no `Mcp-Session-Id`, and a fresh Server + transport per
 * request. This is the default because it is the only mode that is correct on
 * an autoscaled host.
 *
 * With sessions, `initialize` builds in-memory state on one instance and the
 * next `tools/call` gets load-balanced to a different instance that has never
 * heard of that session ID, which fails with "Invalid or missing session ID".
 * Stateless has no such affinity requirement.
 *
 * Nothing is lost here: this server sends no server-initiated messages (the
 * tool list is fixed at build time, and there are no resources or prompts to
 * subscribe to), so the standalone SSE stream that sessions exist to support
 * has nothing to carry. Set MCP_STATELESS=false for the session-based
 * transport on a single-instance deployment.
 */
/**
 * Decode an HTTP Basic `Authorization` header into its credential pair.
 *
 * The OAuth metadata advertises `client_secret_post`, but some MCP clients
 * present `client_secret_basic` regardless. Returns undefined for any header
 * that is absent, a different scheme, or not decodable.
 */
export function parseBasicAuth(header?: string): { clientId: string; clientSecret: string } | undefined {
  if (!header?.toLowerCase().startsWith('basic ')) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return undefined;
  // RFC 6749 §2.3.1 form-encodes both halves before base64.
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const clientId = decode(decoded.slice(0, sep));
  const clientSecret = decode(decoded.slice(sep + 1));
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

/**
 * Pick the protocol version to hand the transport for a request.
 *
 * The SDK rejects any `MCP-Protocol-Version` it does not know with a 400, so a
 * client negotiating a revision newer than this build refuses to connect at
 * all. A newer date means the client can speak everything we can, so we clamp
 * it to our latest and let normal negotiation apply. Unknown *older* values
 * are left alone so they still fail loudly.
 */
export function negotiateProtocolVersion(requested?: string): string | undefined {
  if (!requested) return undefined;
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) return requested;
  return requested > LATEST_PROTOCOL_VERSION ? LATEST_PROTOCOL_VERSION : requested;
}

export function statelessEnabled(): boolean {
  return process.env.MCP_STATELESS !== 'false';
}

/**
 * Returns plain JSON instead of an SSE stream for POST responses. Off by
 * default: SSE is the spec's preferred shape and works through the usual
 * proxies. Turn it on for an intermediary that buffers or breaks event streams.
 */
function jsonResponseEnabled(): boolean {
  return process.env.MCP_JSON_RESPONSE === 'true';
}

/**
 * Build the Express app + auth provider without binding to a port.
 * Used by both `startHttpServer()` and the test harness.
 */
export async function createApp(): Promise<{
  app: express.Express;
  authProvider: StarlinkAuthProvider;
  baseUrl: URL;
  mcpUrl: URL;
}> {
  const config = loadConfig();
  const port = parseInt(process.env.PORT || process.env.MCP_PORT || '3000', 10);
  const baseUrl = new URL(process.env.MCP_BASE_URL || `http://localhost:${port}`);
  const mcpUrl = new URL('/mcp', baseUrl);

  const authProvider = new StarlinkAuthProvider({
    tokenUrl: config.starlink.tokenUrl,
    // When the operator sets STARLINK_CLIENT_ID/SECRET, run in single-account
    // mode: the login page is skipped and everyone shares this service account.
    defaultClientId: config.starlink.clientId,
    defaultClientSecret: config.starlink.clientSecret,
    // Pass-through mode: the MCP client supplies the Starlink service-account
    // credentials as its OAuth client_id + client_secret (configured in Claude),
    // and the server validates/forwards them. No login page, no server creds.
    passthrough: process.env.MCP_AUTH_MODE === 'passthrough',
  });

  const taskStore = await createTaskStore();
  const { app } = wireApp(config, authProvider, baseUrl, mcpUrl, taskStore);
  return { app, authProvider, baseUrl, mcpUrl };
}

export async function startHttpServer(): Promise<void> {
  const { app, baseUrl, mcpUrl } = await createApp();
  const config = loadConfig();
  const port = parseInt(process.env.PORT || process.env.MCP_PORT || '3000', 10);
  const host = process.env.MCP_HOST || '0.0.0.0';

  app.listen(port, host, () => {
    logger.info('Starlink MCP HTTP server started', {
      host,
      port,
      authorize: `${baseUrl.origin}/authorize`,
      mcp: mcpUrl.href,
      mode: statelessEnabled() ? 'stateless' : 'session',
    });
    if (config.debug) {
      logger.debug('Debug mode enabled', { apiUrl: config.starlink.apiUrl });
    }
  });
}

/**
 * Origins permitted to call this server, from MCP_ALLOWED_ORIGINS.
 *
 * Unset means "no browser origin restriction", which is the right default for a
 * hosted, bearer-gated deployment whose callers are native MCP clients that
 * send no Origin at all. Set it whenever the server is reachable from a
 * browser, or bound to localhost, where DNS rebinding is a real attack.
 */
function allowedOrigins(): string[] | null {
  const raw = process.env.MCP_ALLOWED_ORIGINS?.trim();
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

function wireApp(
  config: ReturnType<typeof loadConfig>,
  authProvider: StarlinkAuthProvider,
  baseUrl: URL,
  mcpUrl: URL,
  taskStore?: TaskStore,
): { app: express.Express; sessions: Map<string, { transport: StreamableHTTPServerTransport; server: Server }> } {
  const app = express();
  app.set('trust proxy', 1);

  // Origin validation. MCP 2025-11-25 requires a rejected Origin to be answered
  // with 403, not a silent CORS failure — the caller should learn it was refused
  // rather than see an opaque network error.
  const origins = allowedOrigins();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origins && origin && !origins.includes(origin)) {
      logger.warn('Rejected request with disallowed Origin', { origin, path: req.path });
      res.status(403).json({ error: 'forbidden', error_description: `Invalid Origin: ${origin}` });
      return;
    }
    next();
  });

  // CORS. When an allowlist exists we echo the caller's own origin rather than
  // a wildcard, so credentialed browser requests keep working.
  const corsOrigin = process.env.MCP_CORS_ORIGIN || '*';
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    res.header('Access-Control-Allow-Origin', origins && origin ? origin : corsOrigin);
    if (origins) res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Accept, Last-Event-ID',
    );
    res.header('Access-Control-Expose-Headers', 'mcp-session-id, WWW-Authenticate');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Rate limiters
  const rateLimitMessage = { error: 'Too many requests, please try again later' };
  const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, message: rateLimitMessage });
  const tokenLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: rateLimitMessage });
  const mcpLimiter = rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false, message: rateLimitMessage });
  app.use('/login', loginLimiter);
  app.use('/token', tokenLimiter);
  app.use('/register', tokenLimiter);
  app.use('/mcp', mcpLimiter);

  // Active sessions keyed by session ID
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();

  // Health check — unauthenticated
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      activeSessions: sessions.size,
      apiUrl: config.starlink.apiUrl,
      version: config.version,
    });
  });

  // Favicon — fetch MCP_ICON_URL once and cache in memory; serve bytes directly.
  let cachedIcon: { contentType: string; bytes: Buffer; etag: string } | null = null;
  let cachedIconUrl: string | undefined;
  const fetchIcon = async (url: string) => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Icon fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get('content-type') || 'image/png';
    const etag = `"${createHash('sha1').update(buf).digest('hex')}"`;
    return { contentType: ct, bytes: buf, etag };
  };
  app.get(['/favicon.ico', '/favicon.png'], async (req, res) => {
    const iconUrl = process.env.MCP_ICON_URL;
    if (!iconUrl) {
      res.status(404).end();
      return;
    }
    try {
      if (!cachedIcon || cachedIconUrl !== iconUrl) {
        cachedIcon = await fetchIcon(iconUrl);
        cachedIconUrl = iconUrl;
      }
      if (req.headers['if-none-match'] === cachedIcon.etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', cachedIcon.contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('ETag', cachedIcon.etag);
      res.send(cachedIcon.bytes);
    } catch (err) {
      logger.warn('Failed to fetch icon, serving 404', { iconUrl, error: String(err) });
      res.status(404).end();
    }
  });

  // Pass-through capture middlewares — must run BEFORE the OAuth router.
  // In pass-through mode the Starlink credentials ride in as the OAuth
  // client_id/secret, which the SDK's handlers don't forward to the provider:
  //   • /authorize: record the presented redirect_uri so the synthesized
  //     dynamic client passes the SDK's redirect check.
  //   • /token: stash the presented client_secret (keyed by auth code) so the
  //     provider can validate it against Starlink during the code exchange.
  if (process.env.MCP_AUTH_MODE === 'passthrough') {
    app.use('/authorize', (req, _res, next) => {
      const src = (req.method === 'POST' ? (req as any).body : req.query) || {};
      if (src.client_id) {
        authProvider.rememberClient(String(src.client_id), src.redirect_uri ? String(src.redirect_uri) : undefined);
      }
      next();
    });
    app.post('/token', (req, _res, next) => {
      const body = ((req as any).body ||= {});
      // Some clients send credentials as HTTP Basic even though the metadata
      // advertises client_secret_post only. Fold them into the body so both
      // the SDK's clientAuth and the capture below see them.
      const basic = parseBasicAuth(req.headers.authorization);
      if (basic) {
        if (!body.client_id) body.client_id = basic.clientId;
        if (!body.client_secret) body.client_secret = basic.clientSecret;
      }
      if (body.code && body.client_secret) {
        authProvider.captureTokenSecret(String(body.code), String(body.client_secret));
      }
      next();
    });
  }

  // OAuth endpoints — discovery, authorize, token, register, revoke
  app.use(mcpAuthRouter({
    provider: authProvider,
    issuerUrl: baseUrl,
    resourceServerUrl: mcpUrl,
  }));

  // Compatibility: also serve protected-resource metadata at the root path.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [baseUrl.href],
    });
  });

  // Login form submission — authorize() shows the page, this handles the POST.
  app.post('/login', async (req, res) => {
    const { clientId, clientSecret } = req.body as { clientId?: string; clientSecret?: string };
    if (!clientId || !clientSecret) {
      res.status(400).json({ error: 'Missing clientId or clientSecret' });
      return;
    }
    await authProvider.handleLogin(req, res, clientId, clientSecret);
  });

  // -----------------------------------------------------------------------
  // MCP transport — all routes require bearer auth
  // -----------------------------------------------------------------------

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
  const bearerAuth = requireBearerAuth({ verifier: authProvider, resourceMetadataUrl });

  const stateless = statelessEnabled();
  const enableJsonResponse = jsonResponseEnabled();

  /**
   * Serves one request on a throwaway Server + transport pair.
   *
   * The SDK forbids reusing a stateless transport (request IDs would collide
   * between clients), so both are built per request and torn down when the
   * response closes.
   */
  const handleStatelessRequest = async (req: AuthenticatedRequest, res: ServerResponse) => {
    const { server } = createAuthenticatedMcpServer(
      config,
      req.auth?.extra as Record<string, unknown> | undefined,
      taskStore,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse,
    });

    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, (req as any).body);
  };

  // Clamp a future protocol revision to the newest one this build supports.
  // Must run before the transport, which 400s on an unrecognised value.
  app.use('/mcp', (req, _res, next) => {
    const requested = req.headers['mcp-protocol-version'];
    if (typeof requested === 'string') {
      const negotiated = negotiateProtocolVersion(requested);
      if (negotiated && negotiated !== requested) {
        logger.debug('Clamped MCP-Protocol-Version', { requested, negotiated });
        req.headers['mcp-protocol-version'] = negotiated;
      }
    }
    next();
  });

  app.post('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
    if (stateless) {
      await handleStatelessRequest(req, res);
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const body = (req as any).body;

    if (isInitializeRequest(body)) {
      const { server } = createAuthenticatedMcpServer(
        config,
        req.auth?.extra as Record<string, unknown> | undefined,
        taskStore,
      );

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse,
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { transport, server });
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(req, res, body);
  });

  app.get('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
    if (stateless) {
      // The standalone GET stream carries server-initiated messages, which
      // require a session to be addressed to. Say so plainly instead of
      // handing back a stream that can never produce anything.
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed: server runs in stateless mode' },
          id: null,
        }),
      );
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(req, res);
  });

  app.delete('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
    if (stateless) {
      // Nothing to tear down, and a client that politely closes its session
      // should not see that as a failure.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'no session to terminate (stateless mode)' }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.close();
    sessions.delete(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'session terminated' }));
  });

  return { app, sessions };
}

// ---------------------------------------------------------------------------
// Helper: create a Server + Client bound to a specific user's Starlink token
// ---------------------------------------------------------------------------

function createAuthenticatedMcpServer(
  config: ReturnType<typeof loadConfig>,
  extra?: Record<string, unknown>,
  taskStore?: TaskStore,
) {
  const clientId = extra?.starlinkClientId as string | undefined;
  const clientSecret = extra?.starlinkClientSecret as string | undefined;
  const accessToken = extra?.starlinkAccessToken as string | undefined;

  // Prefer the session's service-account credentials: the client then mints and
  // re-mints its own Starlink token, so a ~15-min upstream token expiring
  // mid-session self-heals (re-mint on expiry and on 401). Fall back to a static
  // token, then to the operator-level config (stdio-style).
  const starlink =
    clientId && clientSecret
      ? { apiUrl: config.starlink.apiUrl, tokenUrl: config.starlink.tokenUrl, clientId, clientSecret, timeout: config.starlink.timeout }
      : accessToken
        ? { apiUrl: config.starlink.apiUrl, tokenUrl: config.starlink.tokenUrl, accessToken, timeout: config.starlink.timeout }
        : config.starlink;

  return createMcpServer({ ...config, starlink }, { taskStore });
}
