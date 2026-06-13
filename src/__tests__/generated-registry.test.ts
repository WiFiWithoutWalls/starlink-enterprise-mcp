/**
 * Sanity checks on the auto-generated tool registry.
 *
 * Asserts the shape and key invariants of the registry that `npm run generate`
 * produces from spec/starlink-enterprise-v2.json:
 *   - non-zero tool count
 *   - every tool has a usable schema and an async handler
 *   - exposed names respect the MCP 64-char limit
 *   - every input schema compiles under ajv 2020 (what the Anthropic API checks)
 */

import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../generated/registry.js';
import { getAllToolDefinitions } from '../tools/index.js';

describe('generated registry', () => {
  it('exposes the full Starlink tool surface', () => {
    expect(toolRegistry.size).toBe(55);
  });

  it('every tool has a schema with name/description/inputSchema and an async handler', () => {
    for (const [name, def] of toolRegistry) {
      expect(def.schema.name).toBe(name);
      expect(typeof def.schema.description).toBe('string');
      expect(def.schema.description.length).toBeGreaterThan(0);
      expect(typeof def.schema.inputSchema).toBe('object');
      expect(typeof def.handler).toBe('function');
      expect(def.handler.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('contains expected anchor tools', () => {
    expect(toolRegistry.has('get_account')).toBe(true);
    expect(toolRegistry.has('get_service_lines')).toBe(true);
    expect(toolRegistry.has('get_user_terminals')).toBe(true);
  });

  it('every description carries an [METHOD /path] tag', () => {
    for (const [, def] of toolRegistry) {
      expect(def.schema.description).toMatch(/\[(GET|POST|PUT|DELETE|PATCH) \/public\/v2\//);
    }
  });
});

describe('exposed tool names', () => {
  it('all fit within the MCP 64-character limit', () => {
    for (const t of getAllToolDefinitions()) {
      expect(t.name.length).toBeLessThanOrEqual(64);
    }
  });

  it('shortens the long service-line names', () => {
    const names = getAllToolDefinitions().map((t) => t.name);
    expect(names).toContain('get_service_line_billing_cycles_partial_periods');
    expect(names).toContain('delete_service_line_user_terminal');
  });
});

describe('input schemas are valid JSON Schema draft 2020-12', () => {
  it('every generated tool schema compiles under ajv 2020', async () => {
    const Ajv2020 = (await import('ajv/dist/2020.js')).default;
    const ajv = new (Ajv2020 as never as { new (opts: object): { compile: (s: object) => unknown } })({ strict: false });
    const failures: string[] = [];
    for (const t of getAllToolDefinitions()) {
      try {
        ajv.compile(t.inputSchema);
      } catch (err) {
        failures.push(`${t.name}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
