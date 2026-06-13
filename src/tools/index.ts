/**
 * Tool registry — wraps the auto-generated registry in src/generated/ and
 * layers on read/write annotations, operator disable patterns, and the
 * dispatch hookup for the MCP Server.
 *
 * The generated layer is produced by `npm run generate` from
 * spec/starlink-enterprise-v2.json. Do not edit src/generated/ by hand.
 *
 * The Starlink Enterprise API is small enough (55 operations) that every tool
 * is exposed directly — no curated catalog or role filtering. Starlink's RBAC
 * is enforced server-side by the service account's permission set.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { StarlinkClient } from '../starlink-client.js';
import { toolRegistry } from '../generated/registry.js';
import type { GenericApiClient, ToolDefinition } from '../generated/types.js';

// ---------------------------------------------------------------------------
// Read/write classification (annotations only)
// ---------------------------------------------------------------------------

const READ_PREFIXES = ['get_', 'list_', 'count_', 'search_', 'query_'];
const DESTRUCTIVE_HINTS = ['delete_', 'remove_'];
const DESTRUCTIVE_SUBSTRINGS = ['reboot'];

function classifyTool(name: string): { readOnlyHint: boolean; destructiveHint: boolean } {
  if (READ_PREFIXES.some((p) => name.startsWith(p))) {
    return { readOnlyHint: true, destructiveHint: false };
  }
  const destructive =
    DESTRUCTIVE_HINTS.some((p) => name.startsWith(p)) ||
    DESTRUCTIVE_SUBSTRINGS.some((s) => name.includes(s));
  return { readOnlyHint: false, destructiveHint: destructive };
}

// ---------------------------------------------------------------------------
// Disabled-tool patterns (MCP_DISABLED_TOOLS, MCP_DISABLED_ACTIONS)
// ---------------------------------------------------------------------------

function compileToolPatterns(patterns: string): RegExp | null {
  const list = patterns.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return null;
  const regexParts = list.map((pat) =>
    pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'),
  );
  return new RegExp(`^(${regexParts.join('|')})$`);
}

let disabledPatternsCache: { source: string; regex: RegExp | null } | null = null;
function getDisabledPattern(): RegExp | null {
  const env = process.env.MCP_DISABLED_TOOLS || '';
  if (!disabledPatternsCache || disabledPatternsCache.source !== env) {
    disabledPatternsCache = { source: env, regex: compileToolPatterns(env) };
  }
  return disabledPatternsCache.regex;
}

export function isToolDisabled(name: string): boolean {
  const re = getDisabledPattern();
  return re ? re.test(name) : false;
}

let disabledActionsCache: { source: string; set: Set<string> } | null = null;
function getDisabledActions(): Set<string> {
  const env = process.env.MCP_DISABLED_ACTIONS || '';
  if (!disabledActionsCache || disabledActionsCache.source !== env) {
    const set = new Set(env.split(',').map((s) => s.trim()).filter(Boolean));
    disabledActionsCache = { source: env, set };
  }
  return disabledActionsCache.set;
}

export function isActionDisabled(action: unknown): boolean {
  if (typeof action !== 'string') return false;
  const set = getDisabledActions();
  if (set.size === 0) return false;
  return set.has(action);
}

// ---------------------------------------------------------------------------
// Semantic destructive filter (MCP_DISABLE_DESTRUCTIVE)
// ---------------------------------------------------------------------------

function disableDestructiveEnabled(): boolean {
  return process.env.MCP_DISABLE_DESTRUCTIVE === 'true';
}

export function isToolDestructive(name: string): boolean {
  return classifyTool(name).destructiveHint;
}

// ---------------------------------------------------------------------------
// Name shortening
//
// MCP clients (Claude, ChatGPT) cap tool names at 64 characters. A couple of
// deep service-line paths blow past that, so we collapse the REST verbiage for
// those names only. Names <= 64 chars are exposed verbatim.
// ---------------------------------------------------------------------------

const SHORTEN_RULES: Array<[RegExp, string]> = [
  [/service_lines_by_service_line_number/g, 'service_line'],
  [/user_terminals_by_device_id/g, 'user_terminal'],
  [/addresses_by_address_reference_id/g, 'address'],
  [/contacts_by_subject_id/g, 'contact'],
  [/routers_by_router_id/g, 'router'],
  [/configs_by_config_id/g, 'config'],
  [/data_pools_by_data_pool_id/g, 'data_pool'],
];

function shortenName(name: string): string {
  let out = name;
  for (const [pattern, replacement] of SHORTEN_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

const MCP_MAX_NAME_LEN = 64;

interface NameMapping {
  exposedToRegistry: Map<string, string>;
  registryToExposed: Map<string, string>;
}

let nameMappingCache: NameMapping | null = null;
function buildNameMapping(): NameMapping {
  if (nameMappingCache) return nameMappingCache;
  const exposedToRegistry = new Map<string, string>();
  const registryToExposed = new Map<string, string>();
  for (const [registryKey] of toolRegistry) {
    let exposed = registryKey;
    if (registryKey.length > MCP_MAX_NAME_LEN) {
      exposed = shortenName(registryKey);
    }
    if (exposed.length > MCP_MAX_NAME_LEN) {
      const hash = Buffer.from(registryKey).toString('base64url').slice(0, 6);
      exposed = `${exposed.slice(0, MCP_MAX_NAME_LEN - 7)}_${hash}`;
    }
    if (exposedToRegistry.has(exposed)) {
      const hash = Buffer.from(registryKey).toString('base64url').slice(0, 4);
      exposed = `${exposed.slice(0, MCP_MAX_NAME_LEN - 5)}_${hash}`;
    }
    exposedToRegistry.set(exposed, registryKey);
    registryToExposed.set(registryKey, exposed);
  }
  nameMappingCache = { exposedToRegistry, registryToExposed };
  return nameMappingCache;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function getAllToolDefinitions(): Array<{
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}> {
  const mapping = buildNameMapping();
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: object;
    annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  }> = [];
  for (const [registryKey, def] of toolRegistry) {
    const exposed = mapping.registryToExposed.get(registryKey) ?? registryKey;
    if (isToolDisabled(exposed) || isToolDisabled(registryKey)) continue;
    const annotations = classifyTool(registryKey);
    if (disableDestructiveEnabled() && annotations.destructiveHint) continue;
    tools.push({
      name: exposed,
      description: def.schema.description,
      inputSchema: def.schema.inputSchema,
      annotations,
    });
  }
  return tools;
}

export async function handleToolCall(
  client: StarlinkClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (isToolDisabled(toolName)) {
    throw new McpError(ErrorCode.MethodNotFound, `Tool '${toolName}' is disabled on this server`);
  }
  if (args && isActionDisabled((args as { action?: unknown }).action)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Action '${(args as { action?: unknown }).action}' is disabled on this server (blocked by MCP_DISABLED_ACTIONS)`,
    );
  }
  if (disableDestructiveEnabled() && isToolDestructive(toolName)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Tool '${toolName}' is destructive and MCP_DISABLE_DESTRUCTIVE is set`,
    );
  }

  const mapping = buildNameMapping();
  const registryKey = mapping.exposedToRegistry.get(toolName) ?? toolName;
  const def: ToolDefinition | undefined = toolRegistry.get(registryKey);
  if (!def) return null;
  return def.handler(args ?? {}, client as unknown as GenericApiClient);
}

/**
 * Wires ListTools and CallTool handlers onto an MCP Server.
 */
export function registerAllTools(server: Server, client: StarlinkClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getAllToolDefinitions() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleToolCall(client, name, (args ?? {}) as Record<string, unknown>);
      if (result === null || result === undefined) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      return result as { content: Array<{ type: 'text'; text: string }> };
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(ErrorCode.InternalError, `Error executing tool ${name}: ${error}`);
    }
  });
}
