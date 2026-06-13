/**
 * Starlink Enterprise MCP Server
 * Model Context Protocol server for the Starlink Enterprise API.
 *
 * Gives AI agents access to Starlink account, service line, router, user
 * terminal, address, contact, and data-pool management. Authentication uses
 * Starlink V2 service-account credentials (client_credentials grant) — see
 * src/auth/starlink-token-manager.ts and src/auth/starlink-auth-provider.ts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StarlinkClient } from './starlink-client.js';
import { MCPServerConfig } from './types/config.js';
import { logger } from './utils/logger.js';
import { getAllToolDefinitions, registerAllTools } from './tools/index.js';
import { DEFAULT_TOKEN_URL } from './auth/starlink-token-manager.js';

export const DEFAULT_API_URL = 'https://web-api.starlink.com';

export const loadConfig = (): MCPServerConfig => {
  const apiUrl = process.env.STARLINK_API_URL || DEFAULT_API_URL;
  const tokenUrl = process.env.STARLINK_TOKEN_URL || DEFAULT_TOKEN_URL;
  const transport = process.env.MCP_TRANSPORT || 'stdio';
  const isHttp = transport === 'http';

  const hasServiceAccount = !!(process.env.STARLINK_CLIENT_ID && process.env.STARLINK_CLIENT_SECRET);
  const hasAccessToken = !!process.env.STARLINK_ACCESS_TOKEN;

  // In HTTP mode, each user supplies their own service account on the browser
  // login page, so no upstream credentials are required up front. In stdio
  // mode the operator must provide either a service account or a bearer token.
  if (!isHttp && !hasServiceAccount && !hasAccessToken) {
    throw new Error(
      'Authentication required: provide STARLINK_CLIENT_ID and STARLINK_CLIENT_SECRET ' +
        '(a Starlink V2 service account) or a pre-minted STARLINK_ACCESS_TOKEN.',
    );
  }

  const starlink: MCPServerConfig['starlink'] = {
    apiUrl,
    tokenUrl,
    timeout: 30000,
  };
  if (hasServiceAccount) {
    starlink.clientId = process.env.STARLINK_CLIENT_ID!;
    starlink.clientSecret = process.env.STARLINK_CLIENT_SECRET!;
  } else if (hasAccessToken) {
    starlink.accessToken = process.env.STARLINK_ACCESS_TOKEN!;
  }

  return {
    name: 'starlink-enterprise-mcp',
    version: '1.0.0',
    starlink,
    debug: process.env.DEBUG === 'true',
  };
};

/** Returns the list of tool definitions exposed by this MCP server. */
export function getToolDefinitions() {
  return getAllToolDefinitions();
}

/** Registers tool handlers on a Server instance, wired to the given StarlinkClient. */
export function registerTools(server: Server, client: StarlinkClient): void {
  registerAllTools(server, client);
}

/**
 * Creates a configured MCP Server + StarlinkClient pair without connecting a
 * transport. Used by both the stdio and HTTP code paths.
 */
export function createMcpServer(config: MCPServerConfig): { server: Server; client: StarlinkClient } {
  const server = new Server(
    { name: config.name, version: config.version },
    { capabilities: { tools: {} } },
  );
  const client = new StarlinkClient(config.starlink);
  registerTools(server, client);
  server.onerror = (error) => logger.error('[MCP Error]', { error: String(error) });
  return { server, client };
}

export class StarlinkMCPServer {
  private server: Server;
  private client: StarlinkClient;

  constructor(config: MCPServerConfig) {
    const { server, client } = createMcpServer(config);
    this.server = server;
    this.client = client;
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    const config = loadConfig();
    if (config.debug) {
      logger.debug('Starlink MCP Server started', { apiUrl: config.starlink.apiUrl });
    }
  }
}

export async function main(): Promise<void> {
  const transport = process.env.MCP_TRANSPORT || 'stdio';
  if (transport === 'http') {
    const { startHttpServer } = await import('./http-server.js');
    await startHttpServer();
  } else {
    const config = loadConfig();
    const server = new StarlinkMCPServer(config);
    await server.run();
  }
}

/** Only auto-run when this file is the actual entrypoint (not when imported by tests). */
function isEntrypoint(): boolean {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  try {
    const argvUrl = new URL(`file://${process.argv[1]}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    logger.error('Fatal error starting MCP server', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
