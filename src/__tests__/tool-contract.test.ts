/**
 * The MCP tool contract: schemas, structured output, error reporting, and
 * pagination.
 *
 * The rules being enforced here are the ones a client actually relies on:
 * a declared outputSchema obliges every success result to carry matching
 * structuredContent, and a tool that fails must say so in the result rather
 * than as a protocol error.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import { toolRegistry } from '../generated/registry.js';
import { getAllToolDefinitions, handleToolCall, listToolsPage } from '../tools/index.js';
import { resetValidatorCache } from '../tools/validate.js';
import { StarlinkClient } from '../starlink-client.js';

vi.mock('axios');

const ORIG_ENV = { ...process.env };

function clientReturning(data: unknown): StarlinkClient {
  const apiRequest = vi.fn().mockResolvedValue({ data });
  vi.mocked(axios.create).mockReturnValue({ request: apiRequest } as unknown as AxiosInstance);
  return new StarlinkClient({
    apiUrl: 'https://www.starlink.com/api',
    tokenUrl: 'https://www.starlink.com/api/auth/connect/token',
    accessToken: 'tok',
  });
}

function clientFailing(status: number, body: unknown): StarlinkClient {
  const apiRequest = vi.fn().mockRejectedValue({ response: { status, data: body } });
  vi.mocked(axios.create).mockReturnValue({ request: apiRequest } as unknown as AxiosInstance);
  return new StarlinkClient({
    apiUrl: 'https://www.starlink.com/api',
    tokenUrl: 'https://www.starlink.com/api/auth/connect/token',
    accessToken: 'tok',
  });
}

beforeEach(() => {
  process.env = { ...ORIG_ENV };
  vi.mocked(axios.create).mockReset();
  resetValidatorCache();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  resetValidatorCache();
});

describe('tool metadata', () => {
  it('gives every tool a human-readable title', () => {
    const untitled = getAllToolDefinitions().filter((t) => !t.title);
    expect(untitled).toEqual([]);
  });

  it('annotates reads, destructive writes, idempotency, and open-world access', () => {
    const tools = getAllToolDefinitions();
    const get = tools.find((t) => t.name === 'get_account')!;
    expect(get.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });

    const reboot = tools.find((t) => t.name === 'post_routers_by_router_id_reboot')!;
    expect(reboot.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it('marks tools as task-forbidden unless tasks are enabled', () => {
    expect(getAllToolDefinitions()[0].execution).toEqual({ taskSupport: 'forbidden' });
    process.env.MCP_TASKS = 'true';
    expect(getAllToolDefinitions()[0].execution).toEqual({ taskSupport: 'optional' });
  });

  it('attaches icons only when MCP_ICON_URL is configured', () => {
    expect(getAllToolDefinitions()[0].icons).toBeUndefined();
    process.env.MCP_ICON_URL = 'https://cdn.example.com/icon.svg';
    expect(getAllToolDefinitions()[0].icons).toEqual([
      { src: 'https://cdn.example.com/icon.svg', sizes: ['any'], mimeType: 'image/svg+xml' },
    ]);
  });
});

describe('output schemas', () => {
  it('declares an object-rooted outputSchema on the great majority of tools', () => {
    const tools = getAllToolDefinitions();
    const withSchema = tools.filter((t) => t.outputSchema);
    expect(withSchema.length).toBeGreaterThanOrEqual(50);
    for (const tool of withSchema) {
      expect(tool.outputSchema!.type).toBe('object');
      expect(tool.outputSchema!.properties).toBeDefined();
    }
  });

  it('compiles every output schema under ajv 2020', async () => {
    const { Ajv2020 } = await import('ajv/dist/2020.js');
    const ajv = new Ajv2020({ strict: false });
    const failures: string[] = [];
    for (const tool of getAllToolDefinitions()) {
      if (!tool.outputSchema) continue;
      try {
        ajv.compile(tool.outputSchema);
      } catch (err) {
        failures.push(`${tool.name}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('never demands required fields or forbids extra ones', () => {
    // A response that has drifted from the published spec must still validate,
    // otherwise a strict client rejects a perfectly good result.
    const offenders: string[] = [];
    const walk = (node: any, path: string) => {
      if (!node || typeof node !== 'object') return;
      if (node.required) offenders.push(`${path}.required`);
      if (node.additionalProperties === false) offenders.push(`${path}.additionalProperties`);
      for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.${key}`);
      if (node.items) walk(node.items, `${path}[]`);
    };
    for (const tool of getAllToolDefinitions()) {
      if (tool.outputSchema) walk(tool.outputSchema, tool.name);
    }
    expect(offenders).toEqual([]);
  });

  it('returns structuredContent matching the declared schema', async () => {
    const payload = { content: { accountNumber: 'ACC-1', regionCode: 'US' }, isValid: true };
    const result = await handleToolCall(clientReturning(payload), 'get_account', {});

    expect(result!.isError).toBeFalsy();
    expect(result!.structuredContent).toEqual(payload);

    const { Ajv2020 } = await import('ajv/dist/2020.js');
    const schema = getAllToolDefinitions().find((t) => t.name === 'get_account')!.outputSchema!;
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(result!.structuredContent)).toBe(true);
  });

  it('still validates when the API returns fields the spec never mentioned', async () => {
    const payload = { content: { accountNumber: 'ACC-1', somethingNew: 42 }, unexpectedTopLevel: true };
    const result = await handleToolCall(clientReturning(payload), 'get_account', {});

    const { Ajv2020 } = await import('ajv/dist/2020.js');
    const schema = getAllToolDefinitions().find((t) => t.name === 'get_account')!.outputSchema!;
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(result!.structuredContent)).toBe(true);
  });

  it('drops both the schema and the structuredContent when disabled', async () => {
    process.env.MCP_STRUCTURED_OUTPUT = 'false';
    expect(getAllToolDefinitions().every((t) => !t.outputSchema)).toBe(true);

    const result = await handleToolCall(clientReturning({ content: {} }), 'get_account', {});
    expect(result!.structuredContent).toBeUndefined();
    expect(result!.content[0]).toMatchObject({ type: 'text' });
  });
});

describe('tool execution errors', () => {
  it('reports an upstream API failure as isError, not a thrown protocol error', async () => {
    const result = await handleToolCall(
      clientFailing(403, { error: 'Missing required permission' }),
      'get_account',
      {},
    );
    expect(result!.isError).toBe(true);
    expect((result!.content[0] as { text: string }).text).toContain('Missing required permission');
    expect(result!.structuredContent).toBeUndefined();
  });

  it('reports a missing required parameter so the model can correct itself', async () => {
    const result = await handleToolCall(clientReturning({}), 'get_routers_by_router_id', {});
    expect(result!.isError).toBe(true);
    expect((result!.content[0] as { text: string }).text).toContain("missing required parameter 'routerId'");
  });

  it('never reaches the API when arguments are invalid', async () => {
    const apiRequest = vi.fn();
    vi.mocked(axios.create).mockReturnValue({ request: apiRequest } as unknown as AxiosInstance);
    const client = new StarlinkClient({
      apiUrl: 'https://www.starlink.com/api',
      tokenUrl: 'https://www.starlink.com/api/auth/connect/token',
      accessToken: 'tok',
    });
    await handleToolCall(client, 'get_routers_by_router_id', {});
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('coerces a stringified number rather than rejecting it', async () => {
    // Models routinely send "50" for a numeric parameter; the intent is clear.
    const client = clientReturning({ content: { results: [] } });
    const result = await handleToolCall(client, 'post_data_usage_query', { limit: '50' });
    expect(result!.isError).toBeFalsy();
  });

  it('surfaces operator policy blocks as isError', async () => {
    process.env.MCP_DISABLE_DESTRUCTIVE = 'true';
    const result = await handleToolCall(
      clientReturning({}),
      'post_routers_by_router_id_reboot',
      { routerId: 'r-1' },
    );
    expect(result!.isError).toBe(true);
    expect((result!.content[0] as { text: string }).text).toContain('MCP_DISABLE_DESTRUCTIVE');
  });

  it('returns null for a tool that does not exist, so the caller can 404 it', async () => {
    expect(await handleToolCall(clientReturning({}), 'no_such_tool', {})).toBeNull();
  });
});

describe('tools/list pagination', () => {
  it('returns every tool in one page by default', () => {
    const page = listToolsPage();
    expect(page.tools.length).toBe(toolRegistry.size);
    expect(page.nextCursor).toBeUndefined();
  });

  it('walks the whole list across pages when a page size is set', () => {
    process.env.MCP_TOOLS_PAGE_SIZE = '20';
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = listToolsPage(cursor);
      expect(page.tools.length).toBeLessThanOrEqual(20);
      seen.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen.length).toBe(toolRegistry.size);
    expect(new Set(seen).size).toBe(toolRegistry.size);
  });

  it('rejects a malformed cursor', () => {
    expect(() => listToolsPage('not-a-real-cursor')).toThrow(/Invalid cursor/);
  });
});
