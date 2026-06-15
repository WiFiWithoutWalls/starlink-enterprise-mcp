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
 */

import { randomUUID, createHash } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { loadConfig, registerTools } from './index.js';
import { StarlinkClient } from './starlink-client.js';
import { StarlinkAuthProvider } from './auth/starlink-auth-provider.js';
import { logger } from './utils/logger.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

interface AuthenticatedRequest extends IncomingMessage {
  auth?: AuthInfo;
  body?: unknown;
}

/**
 * Build the Express app + auth provider without binding to a port.
 * Used by both `startHttpServer()` and the test harness.
 */
export function createApp(): { app: express.Express; authProvider: StarlinkAuthProvider; baseUrl: URL; mcpUrl: URL } {
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

  const { app } = wireApp(config, authProvider, baseUrl, mcpUrl);
  return { app, authProvider, baseUrl, mcpUrl };
}

export async function startHttpServer(): Promise<void> {
  const { app, baseUrl, mcpUrl } = createApp();
  const config = loadConfig();
  const port = parseInt(process.env.PORT || process.env.MCP_PORT || '3000', 10);
  const host = process.env.MCP_HOST || '0.0.0.0';

  app.listen(port, host, () => {
    logger.info('Starlink MCP HTTP server started', {
      host,
      port,
      authorize: `${baseUrl.origin}/authorize`,
      mcp: mcpUrl.href,
    });
    if (config.debug) {
      logger.debug('Debug mode enabled', { apiUrl: config.starlink.apiUrl });
    }
  });
}

function wireApp(
  config: ReturnType<typeof loadConfig>,
  authProvider: StarlinkAuthProvider,
  baseUrl: URL,
  mcpUrl: URL,
): { app: express.Express; sessions: Map<string, { transport: StreamableHTTPServerTransport; server: Server }> } {
  const app = express();
  app.set('trust proxy', 1);

  // CORS
  const corsOrigin = process.env.MCP_CORS_ORIGIN || '*';
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', corsOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, Accept');
    res.header('Access-Control-Expose-Headers', 'mcp-session-id');
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
      const body = (req as any).body || {};
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

  app.post('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const body = (req as any).body;

    if (isInitializeRequest(body)) {
      const extra = req.auth?.extra as Record<string, unknown> | undefined;
      const starlinkAccessToken = extra?.starlinkAccessToken as string | undefined;
      const { server } = createAuthenticatedMcpServer(config, starlinkAccessToken);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
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
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(req, res);
  });

  app.delete('/mcp', bearerAuth, async (req: AuthenticatedRequest, res: ServerResponse) => {
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
  starlinkAccessToken?: string,
) {
  const server = new Server(
    { name: config.name, version: config.version },
    { capabilities: { tools: {} } },
  );

  // Use the per-user Starlink access token resolved from the OAuth session.
  // Fall back to the operator-level config (stdio-style) if absent.
  const clientConfig = starlinkAccessToken
    ? { apiUrl: config.starlink.apiUrl, tokenUrl: config.starlink.tokenUrl, accessToken: starlinkAccessToken, timeout: config.starlink.timeout }
    : config.starlink;

  const client = new StarlinkClient(clientConfig);
  registerTools(server, client);

  server.onerror = (error) => logger.error('[MCP Error]', { error: String(error) });
  return { server, client };
}
