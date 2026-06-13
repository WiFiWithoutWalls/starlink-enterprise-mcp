#!/usr/bin/env tsx

/**
 * OpenAPI-to-MCP Code Generator
 *
 * Reads the Starlink Enterprise API OpenAPI specification and produces MCP
 * tool definitions, handlers, and a registry file under src/generated/.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenApiSpec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components?: { schemas?: Record<string, SchemaObject> };
}

interface PathItem {
  [method: string]: OperationObject | undefined;
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  deprecated?: boolean;
  security?: unknown[];
  responses?: unknown;
}

interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
  example?: unknown;
}

interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  items?: SchemaObject;
  allOf?: SchemaObject[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  examples?: unknown[];
}

interface RequestBodyObject {
  content?: Record<string, { schema?: SchemaObject }>;
  required?: boolean;
}

interface ParsedOperation {
  toolName: string;
  method: string;
  pathTemplate: string;
  rawPath: string;
  tag: string;
  summary: string;
  description: string;
  pathParams: ParsedParam[];
  queryParams: ParsedParam[];
  bodyProperties: ParsedParam[];
  bodyRequired: string[];
  hasBody: boolean;
}

interface ParsedParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
  enumValues?: unknown[];
  defaultValue?: unknown;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch'] as const;

/**
 * Common path prefix stripped from derived tool names. Every Starlink endpoint
 * lives under /public/v2, so leaving it in would add noise (`get_public_v2_*`)
 * to every tool name without disambiguating anything.
 */
const STRIP_PATH_PREFIX = '/public/v2';

/**
 * Tags whose operations are infra/auth/credential endpoints — a security risk
 * if exposed as AI tools (the server handles auth itself). Operations in these
 * tags are dropped at generation time. The Starlink spec has none today; the
 * guard is kept so a future spec drop can't silently expose credential tools.
 */
const EXCLUDED_TAGS = new Set<string>([
  'Authentication',
]);

/** JS/TS reserved words that cannot be used as identifiers. */
const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'yield', 'let', 'static', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'await', 'async',
]);

function sanitizeIdentifier(name: string): string {
  if (RESERVED_WORDS.has(name)) return `op_${name}`;
  if (/^\d/.test(name)) return `op_${name}`;
  return name;
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = join(rootDir, 'spec', 'starlink-enterprise-v2.json');
const generatedDir = join(rootDir, 'src', 'generated');
const toolsDir = join(generatedDir, 'tools');

function loadSpec(): OpenApiSpec {
  const raw = readFileSync(specPath, 'utf8');
  return JSON.parse(raw) as OpenApiSpec;
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

function resolveRef(spec: OpenApiSpec, ref: string): SchemaObject | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.replace('#/', '').split('/');
  let current: unknown = spec;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as SchemaObject | undefined;
}

/** Resolve a schema, dereferencing one level of $ref and flattening a single allOf. */
function resolveSchema(spec: OpenApiSpec, schema: SchemaObject | undefined): SchemaObject {
  if (!schema) return { type: 'string' };
  if (schema.$ref) {
    const resolved = resolveRef(spec, schema.$ref);
    if (resolved) return resolveSchema(spec, { ...resolved });
    return { type: 'string' };
  }
  if (schema.allOf && schema.allOf.length === 1 && !schema.type && !schema.properties) {
    return resolveSchema(spec, schema.allOf[0]);
  }
  return schema;
}

function mapType(schema: SchemaObject): string {
  const t = schema.type;
  if (t === 'integer' || t === 'number' || t === 'int') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return 'array';
  if (t === 'object') return 'object';
  return 'string';
}

function tagToFileName(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[\/\\]/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/**
 * Derive a tool name from method + path.
 * e.g. POST /public/v2/routers/{routerId}/reboot → post_routers_by_router_id_reboot
 */
function deriveToolName(method: string, rawPath: string): string {
  let path = rawPath;
  if (STRIP_PATH_PREFIX && path.startsWith(STRIP_PATH_PREFIX)) {
    path = path.slice(STRIP_PATH_PREFIX.length);
  }
  const cleaned = path
    .replace(/\{([^}]+)\}/g, 'by_$1') // {param} → by_param
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return toSnakeCase(`${method}_${cleaned}`);
}

function buildParamDescription(name: string, resolvedSchema: SchemaObject, paramDesc?: string): string {
  const parts: string[] = [];
  const desc = paramDesc || resolvedSchema.description || '';
  if (desc) parts.push(desc.replace(/\n/g, ' ').trim());
  if (resolvedSchema.enum) {
    parts.push(`Allowed values: ${resolvedSchema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if (resolvedSchema.default !== undefined) {
    parts.push(`Default: ${JSON.stringify(resolvedSchema.default)}`);
  }
  return parts.join('. ').replace(/\.\./g, '.') || name;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseOperations(spec: OpenApiSpec): ParsedOperation[] {
  const operations: ParsedOperation[] = [];

  for (const [rawPath, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as OperationObject | undefined;
      if (!op) continue;

      const tag = op.tags?.[0] || 'Uncategorized';
      if (EXCLUDED_TAGS.has(tag)) continue;

      const pathTemplate = rawPath;

      const toolName = op.operationId
        ? toSnakeCase(op.operationId)
        : deriveToolName(method, rawPath);

      // --- Parameters ---
      const pathParams: ParsedParam[] = [];
      const queryParams: ParsedParam[] = [];

      for (const param of op.parameters || []) {
        const resolvedSchema = resolveSchema(spec, param.schema);
        const parsed: ParsedParam = {
          name: param.name,
          type: mapType(resolvedSchema),
          description: buildParamDescription(param.name, resolvedSchema, param.description),
          required: param.in === 'path' ? true : (param.required ?? false),
          enumValues: resolvedSchema.enum,
          defaultValue: resolvedSchema.default,
        };
        if (param.in === 'path') pathParams.push(parsed);
        else if (param.in === 'query') queryParams.push(parsed);
        // ignore header/cookie params
      }

      // --- Request body ---
      const bodyProperties: ParsedParam[] = [];
      let bodyRequired: string[] = [];
      let hasBody = false;

      if (op.requestBody?.content) {
        const jsonContent =
          op.requestBody.content['application/json'] ||
          op.requestBody.content['multipart/form-data'] ||
          Object.values(op.requestBody.content)[0];

        if (jsonContent?.schema) {
          hasBody = true;
          let bodySchema = resolveSchema(spec, jsonContent.schema);

          const schemaRequired = bodySchema.required || [];
          bodyRequired = schemaRequired;

          if (bodySchema.properties) {
            for (const [propName, propSchema] of Object.entries(bodySchema.properties)) {
              const resolvedProp = resolveSchema(spec, propSchema);
              bodyProperties.push({
                name: propName,
                type: mapType(resolvedProp),
                description: buildParamDescription(propName, resolvedProp),
                required: schemaRequired.includes(propName),
                enumValues: resolvedProp.enum,
                defaultValue: resolvedProp.default,
              });
            }
          }
        }
      }

      operations.push({
        toolName,
        method: method.toUpperCase(),
        pathTemplate,
        rawPath,
        tag,
        summary: op.summary || '',
        description: op.description || '',
        pathParams,
        queryParams,
        bodyProperties,
        bodyRequired,
        hasBody,
      });
    }
  }

  return operations;
}

function deduplicateToolNames(operations: ParsedOperation[]): void {
  const nameCount = new Map<string, number>();
  for (const op of operations) {
    nameCount.set(op.toolName, (nameCount.get(op.toolName) || 0) + 1);
  }
  const nameIndex = new Map<string, number>();
  for (const op of operations) {
    const count = nameCount.get(op.toolName)!;
    if (count > 1) {
      const idx = (nameIndex.get(op.toolName) || 0) + 1;
      nameIndex.set(op.toolName, idx);
      op.toolName = `${op.toolName}_${idx}`;
    }
  }
  const allNames = new Set<string>();
  for (const op of operations) {
    if (allNames.has(op.toolName)) {
      throw new Error(`Duplicate tool name after dedup: ${op.toolName}`);
    }
    allNames.add(op.toolName);
  }
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function generateInputSchema(op: ParsedOperation): string {
  const properties: Record<string, object> = {};
  const required: string[] = [];

  for (const p of op.pathParams) {
    const prop: Record<string, unknown> = { type: p.type, description: p.description };
    if (p.enumValues) prop.enum = p.enumValues;
    properties[p.name] = prop;
    required.push(p.name);
  }
  for (const p of op.queryParams) {
    const prop: Record<string, unknown> = { type: p.type, description: p.description };
    if (p.enumValues) prop.enum = p.enumValues;
    if (p.defaultValue !== undefined) prop.default = p.defaultValue;
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }
  for (const p of op.bodyProperties) {
    const prop: Record<string, unknown> = { type: p.type, description: p.description };
    if (p.enumValues) prop.enum = p.enumValues;
    if (p.defaultValue !== undefined) prop.default = p.defaultValue;
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }

  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) {
    schema.required = [...new Set(required)];
  }
  return JSON.stringify(schema, null, 6);
}

function generateToolDescription(op: ParsedOperation): string {
  const parts: string[] = [];
  if (op.summary) parts.push(op.summary);
  if (op.description && op.description !== op.summary) {
    parts.push(op.description.replace(/\n/g, ' ').trim());
  }
  parts.push(`[${op.method} ${op.pathTemplate}]`);
  return parts.join(' — ').replace(/'/g, "\\'");
}

function generateHandlerBody(op: ParsedOperation): string {
  const lines: string[] = [];

  if (op.pathParams.length > 0) {
    const paramNames = op.pathParams.map((p) => `'${p.name}'`).join(', ');
    lines.push(`    const pathParamNames = [${paramNames}];`);
    lines.push(`    const pathParams: Record<string, string> = {};`);
    lines.push(`    for (const name of pathParamNames) {`);
    lines.push(`      if (args[name] !== undefined) pathParams[name] = String(args[name]);`);
    lines.push(`    }`);
  }
  if (op.queryParams.length > 0) {
    const paramNames = op.queryParams.map((p) => `'${p.name}'`).join(', ');
    lines.push(`    const queryParamNames = [${paramNames}];`);
    lines.push(`    const queryParams: Record<string, unknown> = {};`);
    lines.push(`    for (const name of queryParamNames) {`);
    lines.push(`      if (args[name] !== undefined) queryParams[name] = args[name];`);
    lines.push(`    }`);
  }
  if (op.hasBody && op.bodyProperties.length > 0) {
    const paramNames = op.bodyProperties.map((p) => `'${p.name}'`).join(', ');
    lines.push(`    const bodyParamNames = [${paramNames}];`);
    lines.push(`    const body: Record<string, unknown> = {};`);
    lines.push(`    for (const name of bodyParamNames) {`);
    lines.push(`      if (args[name] !== undefined) body[name] = args[name];`);
    lines.push(`    }`);
  } else if (op.hasBody) {
    // Body with no documented properties — forward the whole args object.
    lines.push(`    const body: Record<string, unknown> = { ...args };`);
  }

  const requestArgs: string[] = [];
  requestArgs.push(`      method: '${op.method}'`);
  requestArgs.push(`      pathTemplate: '${escapeString(op.pathTemplate)}'`);
  if (op.pathParams.length > 0) requestArgs.push(`      pathParams`);
  if (op.queryParams.length > 0) requestArgs.push(`      queryParams`);
  if (op.hasBody) requestArgs.push(`      body`);

  lines.push(`    const response = await client.request({`);
  lines.push(requestArgs.join(',\n') + ',');
  lines.push(`    });`);
  lines.push(``);
  lines.push(`    return {`);
  lines.push(`      content: [{`);
  lines.push(`        type: 'text' as const,`);
  lines.push(`        text: JSON.stringify(response, null, 2),`);
  lines.push(`      }],`);
  lines.push(`    };`);

  return lines.join('\n');
}

function generateToolFile(_tag: string, operations: ParsedOperation[]): string {
  const lines: string[] = [];
  lines.push(`// Auto-generated by scripts/generate-tools.ts — DO NOT EDIT`);
  lines.push(`import type { ToolDefinition, GenericApiClient } from '../types.js';`);
  lines.push(`import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';`);
  lines.push(``);

  for (const op of operations) {
    const desc = generateToolDescription(op);
    const inputSchema = generateInputSchema(op);
    const identifier = sanitizeIdentifier(op.toolName);
    lines.push(`export const ${identifier}: ToolDefinition = {`);
    lines.push(`  schema: {`);
    lines.push(`    name: '${escapeString(op.toolName)}',`);
    lines.push(`    description: '${escapeString(desc)}',`);
    lines.push(`    inputSchema: ${inputSchema.replace(/\n/g, '\n    ')},`);
    lines.push(`  },`);
    lines.push(`  handler: async (args: Record<string, unknown>, client: GenericApiClient): Promise<CallToolResult> => {`);
    lines.push(generateHandlerBody(op));
    lines.push(`  },`);
    lines.push(`};`);
    lines.push(``);
  }
  return lines.join('\n');
}

function generateRegistryFile(tagGroups: Map<string, ParsedOperation[]>): string {
  const lines: string[] = [];
  lines.push(`// Auto-generated by scripts/generate-tools.ts — DO NOT EDIT`);
  lines.push(`import type { ToolDefinition } from './types.js';`);
  lines.push(``);

  const imports: { fileName: string; tools: { toolName: string; identifier: string }[] }[] = [];
  for (const [tag, ops] of tagGroups) {
    const fileName = tagToFileName(tag);
    const tools = ops.map((o) => ({ toolName: o.toolName, identifier: sanitizeIdentifier(o.toolName) }));
    imports.push({ fileName, tools });
  }
  imports.sort((a, b) => a.fileName.localeCompare(b.fileName));

  for (const imp of imports) {
    const names = imp.tools.map((t) => t.identifier).join(', ');
    lines.push(`import { ${names} } from './tools/${imp.fileName}.js';`);
  }
  lines.push(``);
  lines.push(`export const toolRegistry = new Map<string, ToolDefinition>();`);
  lines.push(``);
  for (const imp of imports) {
    for (const t of imp.tools) {
      lines.push(`toolRegistry.set('${escapeString(t.toolName)}', ${t.identifier});`);
    }
  }
  lines.push(``);
  lines.push(`export default toolRegistry;`);
  lines.push(``);
  return lines.join('\n');
}

function generateTypesFile(): string {
  return `// Auto-generated by scripts/generate-tools.ts — DO NOT EDIT
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface StarlinkApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface GenericApiClient {
  request<T = unknown>(options: {
    method: string;
    pathTemplate: string;
    pathParams?: Record<string, string>;
    queryParams?: Record<string, unknown>;
    body?: unknown;
  }): Promise<StarlinkApiResponse<T>>;
}

export interface ToolDefinition {
  schema: { name: string; description: string; inputSchema: object };
  handler: (args: Record<string, unknown>, client: GenericApiClient) => Promise<CallToolResult>;
}
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log('Loading OpenAPI spec...');
  const spec = loadSpec();
  console.log(`  Title: ${spec.info.title}`);
  console.log(`  Version: ${spec.info.version}`);

  console.log('Parsing operations...');
  const operations = parseOperations(spec);
  console.log(`  Found ${operations.length} operations`);

  console.log('Deduplicating tool names...');
  deduplicateToolNames(operations);

  const allNames = new Set(operations.map((o) => o.toolName));
  console.log(`  ${allNames.size} unique tool names`);
  if (allNames.size !== operations.length) {
    throw new Error(`Name count mismatch: ${allNames.size} unique vs ${operations.length} total`);
  }

  const tagGroups = new Map<string, ParsedOperation[]>();
  for (const op of operations) {
    const existing = tagGroups.get(op.tag) || [];
    existing.push(op);
    tagGroups.set(op.tag, existing);
  }
  console.log(`  ${tagGroups.size} tag groups`);

  if (!existsSync(toolsDir)) mkdirSync(toolsDir, { recursive: true });

  console.log('Generating types...');
  writeFileSync(join(generatedDir, 'types.ts'), generateTypesFile(), 'utf8');

  console.log('Generating tool files...');
  for (const [tag, ops] of tagGroups) {
    const fileName = tagToFileName(tag);
    writeFileSync(join(toolsDir, `${fileName}.ts`), generateToolFile(tag, ops), 'utf8');
    console.log(`  ${fileName}.ts (${ops.length} tools)`);
  }

  console.log('Generating registry...');
  writeFileSync(join(generatedDir, 'registry.ts'), generateRegistryFile(tagGroups), 'utf8');
  console.log(`  registry.ts`);

  console.log(`\nDone! Generated ${operations.length} tools across ${tagGroups.size} files.`);
}

main();
