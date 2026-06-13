/**
 * Configuration types for the Starlink Enterprise MCP Server.
 */

export interface StarlinkConfig {
  /** Starlink Enterprise API base URL (paths are /public/v2/...). */
  apiUrl: string;
  /** OIDC token endpoint for the client_credentials grant. */
  tokenUrl: string;
  /**
   * A pre-minted Starlink bearer token. When set, the client uses it directly
   * (HTTP transport supplies a per-user token this way). Mutually exclusive
   * with clientId/clientSecret, which let the client mint and re-mint its own.
   */
  accessToken?: string;
  /** Service-account Client ID — used to mint/re-mint a bearer via client_credentials. */
  clientId?: string;
  /** Service-account Client Secret. */
  clientSecret?: string;
  /** Optional timeout for API requests (milliseconds). */
  timeout?: number;
}

export interface MCPServerConfig {
  /** Server name. */
  name: string;
  /** Server version. */
  version: string;
  /** Starlink configuration. */
  starlink: StarlinkConfig;
  /** Debug mode. */
  debug?: boolean;
}
