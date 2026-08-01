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
import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { validateToolName } from '@modelcontextprotocol/sdk/shared/toolNameValidation.js';
import { StarlinkClient } from '../starlink-client.js';
import { toolRegistry } from '../generated/registry.js';
import { structuredOutputEnabled } from '../generated/types.js';
import type { GenericApiClient, ToolDefinition } from '../generated/types.js';
import { validateToolInput } from './validate.js';
import { serverIcons } from '../server-metadata.js';
import { startToolTask, tasksEnabled } from '../tasks/index.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Behaviour classification (MCP tool annotations)
// ---------------------------------------------------------------------------

const READ_PREFIXES = ['get_', 'list_', 'count_', 'search_', 'query_'];
const DESTRUCTIVE_HINTS = ['delete_', 'remove_'];
const DESTRUCTIVE_SUBSTRINGS = ['reboot'];
/** HTTP verbs the Starlink API implements idempotently. */
const IDEMPOTENT_PREFIXES = ['get_', 'put_', 'delete_'];

function classifyTool(name: string): Required<
  Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>
> {
  const readOnly = READ_PREFIXES.some((p) => name.startsWith(p));
  const destructive =
    !readOnly &&
    (DESTRUCTIVE_HINTS.some((p) => name.startsWith(p)) ||
      DESTRUCTIVE_SUBSTRINGS.some((s) => name.includes(s)));
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    // GET/PUT/DELETE are idempotent by REST contract; POST/PATCH are not.
    idempotentHint: IDEMPOTENT_PREFIXES.some((p) => name.startsWith(p)),
    // Every tool reaches a live external API whose entity set we do not control.
    openWorldHint: true,
  };
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
    // SEP-986 constrains the character set for tool names. Shortening and
    // hashing above could in principle emit something non-conforming, so the
    // result is checked rather than assumed.
    const { isValid, warnings } = validateToolName(exposed);
    if (!isValid) {
      logger.warn('Generated tool name does not conform to MCP naming guidance', {
        tool: exposed,
        warnings,
      });
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

/**
 * Builds the full MCP `Tool` list, after applying operator policy.
 *
 * Each entry carries the 2025-06-18 `title` and `outputSchema`, the 2025-11-25
 * `icons`, and behaviour annotations. `execution.taskSupport` is only advertised
 * when the deployment actually has a task store behind it — telling a client a
 * tool can be task-augmented when it cannot is worse than staying silent.
 */
export function getAllToolDefinitions(): Tool[] {
  const mapping = buildNameMapping();
  const structured = structuredOutputEnabled();
  const icons = serverIcons();
  const taskSupport = tasksEnabled() ? 'optional' : 'forbidden';
  const tools: Tool[] = [];

  for (const [registryKey, def] of toolRegistry) {
    const exposed = mapping.registryToExposed.get(registryKey) ?? registryKey;
    if (isToolDisabled(exposed) || isToolDisabled(registryKey)) continue;
    const annotations = classifyTool(registryKey);
    if (disableDestructiveEnabled() && annotations.destructiveHint) continue;

    const tool: Tool = {
      name: exposed,
      description: def.schema.description,
      inputSchema: def.schema.inputSchema as Tool['inputSchema'],
      annotations,
      execution: { taskSupport },
    };
    if (def.schema.title) tool.title = def.schema.title;
    // Advertising an outputSchema obliges every result to carry matching
    // structuredContent, so the toggle has to gate both together.
    if (structured && def.schema.outputSchema) {
      tool.outputSchema = def.schema.outputSchema as Tool['outputSchema'];
    }
    if (icons) tool.icons = icons;
    tools.push(tool);
  }
  return tools;
}

/**
 * Page size for tools/list. Defaults to returning every tool in one page —
 * 55 tools is well within what clients handle, and an unnecessary round trip
 * just delays the first tool call. Operators who front a bigger spec can set
 * MCP_TOOLS_PAGE_SIZE to opt into cursor pagination.
 */
function toolsPageSize(): number {
  const raw = parseInt(process.env.MCP_TOOLS_PAGE_SIZE || '0', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Cursors are opaque to clients per spec; ours encodes the next offset. */
function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`).toString('base64url');
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) throw new McpError(ErrorCode.InvalidParams, `Invalid cursor: ${cursor}`);
  return parseInt(match[1], 10);
}

export function listToolsPage(cursor?: string): { tools: Tool[]; nextCursor?: string } {
  const all = getAllToolDefinitions();
  const pageSize = toolsPageSize();
  if (pageSize === 0 && !cursor) return { tools: all };

  const offset = cursor ? decodeCursor(cursor) : 0;
  if (offset > all.length) {
    throw new McpError(ErrorCode.InvalidParams, `Cursor is out of range: ${cursor}`);
  }
  const end = pageSize === 0 ? all.length : offset + pageSize;
  const tools = all.slice(offset, end);
  return end < all.length ? { tools, nextCursor: encodeCursor(end) } : { tools };
}

/** A tool-execution error: reported in the result so the model can self-correct. */
function executionError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Runs a tool call.
 *
 * Returns `null` only when the tool genuinely does not exist — the caller turns
 * that into a protocol error. Every other failure (operator policy, bad
 * arguments, an upstream API error) comes back as a result with `isError: true`.
 * Per SEP-1303 that is what lets the model see the problem and retry with
 * corrected arguments instead of the request just failing.
 */
export async function handleToolCall(
  client: StarlinkClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | null> {
  if (isToolDisabled(toolName)) {
    return executionError(`Tool '${toolName}' is disabled on this server`);
  }
  if (args && isActionDisabled((args as { action?: unknown }).action)) {
    return executionError(
      `Action '${(args as { action?: unknown }).action}' is disabled on this server (blocked by MCP_DISABLED_ACTIONS)`,
    );
  }
  if (disableDestructiveEnabled() && isToolDestructive(toolName)) {
    return executionError(`Tool '${toolName}' is destructive and MCP_DISABLE_DESTRUCTIVE is set`);
  }

  const mapping = buildNameMapping();
  const registryKey = mapping.exposedToRegistry.get(toolName) ?? toolName;
  const def: ToolDefinition | undefined = toolRegistry.get(registryKey);
  if (!def) return null;

  const validation = validateToolInput(registryKey, def.schema.inputSchema, args ?? {});
  if (!validation.ok) {
    return executionError(`Invalid arguments for '${toolName}': ${validation.error}`);
  }

  try {
    return await def.handler(validation.args, client as unknown as GenericApiClient);
  } catch (error) {
    return executionError(
      `Error executing tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Wires ListTools and CallTool handlers onto an MCP Server.
 *
 * When the server has a task store, a `tools/call` carrying `params.task` is
 * accepted as a task-augmented request: it returns a task handle immediately
 * and the result is fetched later via `tasks/result`.
 */
export function registerAllTools(server: Server, client: StarlinkClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return listToolsPage(request.params?.cursor);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const run = () => handleToolCall(client, name, (args ?? {}) as Record<string, unknown>);

    if (request.params.task && extra.taskStore) {
      return startToolTask(extra.taskStore, name, run);
    }

    const result = await run();
    if (result === null) {
      // Failing to *find* a tool is a protocol error, not a tool error.
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return result;
  });
}
