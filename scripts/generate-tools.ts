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
  /**
   * Compact "Returns: ..." doc built from the response schema's field
   * descriptions. Only folded into the description when `outputSchema` is
   * null — otherwise the schema carries the same information structurally and
   * repeating it in prose just doubles the tools/list payload.
   */
  returnsDoc: string;
  /** JSON Schema 2020-12 for the result's `structuredContent`, or null. */
  outputSchema: object | null;
  /** Human-readable display name (MCP `title`), from the OpenAPI summary. */
  title: string;
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
// Response-schema docs
//
// The model otherwise receives raw JSON output with no field semantics. We walk
// the 2xx response schema (through $ref wrappers, allOf, and arrays) and append
// the documented field descriptions to the tool description as a "Returns:"
// section, so the model knows what each field means (e.g. that
// optInPriorityGB is a *subset* of priorityGB, not additive).
// ---------------------------------------------------------------------------

interface RespField {
  path: string;
  type: string;
  desc: string;
}

/** Envelope fields that carry no useful semantics for the model. */
const RESPONSE_ENVELOPE_SKIP = new Set(['errors', 'warnings', 'information']);
const MAX_RESPONSE_FIELDS = 60;
const MAX_RESPONSE_DEPTH = 9;
/** Per-field description cap — generous enough to preserve "subset, not additive"-style caveats. */
const MAX_RESPONSE_FIELD_DESC = 220;

function collectResponseFields(
  spec: OpenApiSpec,
  schema: any,
  path: string,
  ancestry: Set<string>,
  out: RespField[],
  depth: number,
): void {
  if (!schema || out.length >= MAX_RESPONSE_FIELDS || depth > MAX_RESPONSE_DEPTH) return;

  if (schema.$ref) {
    if (ancestry.has(schema.$ref)) return; // cycle guard
    const resolved = resolveRef(spec, schema.$ref);
    if (!resolved) return;
    const next = new Set(ancestry);
    next.add(schema.$ref);
    collectResponseFields(spec, resolved, path, next, out, depth);
    return;
  }
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) collectResponseFields(spec, sub, path, ancestry, out, depth);
    return;
  }
  if (schema.type === 'array' && schema.items) {
    collectResponseFields(spec, schema.items, `${path}[]`, ancestry, out, depth + 1);
    return;
  }
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      if (out.length >= MAX_RESPONSE_FIELDS) return;
      if (RESPONSE_ENVELOPE_SKIP.has(key)) continue;
      const childPath = path ? `${path}.${key}` : key;
      const resolved = value && value.$ref ? resolveRef(spec, value.$ref) ?? value : value;
      const desc = ((value && value.description) || (resolved && resolved.description) || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (desc) out.push({ path: childPath, type: mapType(resolved || {}), desc });
      collectResponseFields(spec, value, childPath, ancestry, out, depth + 1);
    }
  }
}

function buildReturnsDoc(spec: OpenApiSpec, op: OperationObject): string {
  const responses = op.responses as Record<string, any> | undefined;
  if (!responses || typeof responses !== 'object') return '';
  const key =
    Object.keys(responses).find((k) => /^2\d\d$/.test(k)) ?? (responses['default'] ? 'default' : undefined);
  if (!key) return '';
  const content = responses[key]?.content;
  const schema = content && (content['application/json'] || Object.values(content)[0]);
  const sch = schema && (schema as any).schema;
  if (!sch) return '';

  const out: RespField[] = [];
  collectResponseFields(spec, sch, '', new Set(), out, 0);
  if (out.length === 0) return '';

  const items = out.map((f) => {
    let d = f.desc;
    if (d.length > MAX_RESPONSE_FIELD_DESC) d = `${d.slice(0, MAX_RESPONSE_FIELD_DESC - 1)}…`;
    return `${f.path} (${f.type})${d ? `: ${d}` : ''}`;
  });
  return `Returns: ${items.join(' | ')}`;
}

// ---------------------------------------------------------------------------
// Output schemas (MCP structured tool output)
//
// MCP 2025-06-18 added `outputSchema` on a tool plus `structuredContent` on the
// result. We translate the OpenAPI 2xx response schema into JSON Schema
// 2020-12 (the dialect MCP standardized on in 2025-11-25) so clients get typed,
// machine-readable results instead of an opaque JSON blob.
//
// The translation is deliberately PERMISSIVE. Starlink's spec is not a perfect
// description of what the API returns, and a strict client that rejects a
// mismatched result would break the tool entirely. So we never emit `required`
// and never emit `additionalProperties: false` — a response with extra or
// missing fields still validates. Only the shape of fields we do describe is
// asserted, and even that is widened wherever the spec says `nullable`.
// ---------------------------------------------------------------------------

/** Node budget per schema — keeps tools/list from ballooning on deep responses. */
const MAX_OUTPUT_SCHEMA_NODES = 400;
const MAX_OUTPUT_SCHEMA_DEPTH = 8;

interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: unknown[];
  format?: string;
}

/** Maps an OpenAPI type to its JSON Schema equivalent, widening for `nullable`. */
function outputType(schema: any): string | string[] | undefined {
  const raw = schema.type;
  if (!raw) return undefined;
  const base = raw === 'integer' || raw === 'int' ? 'integer' : raw === 'number' ? 'number' : raw;
  return schema.nullable === true ? [base, 'null'] : base;
}

/**
 * Converts one OpenAPI schema node to JSON Schema 2020-12.
 *
 * Returns `{}` (match-anything) once the depth or node budget is exhausted, so
 * a truncated schema still validates every real response rather than rejecting
 * the parts we chose not to describe.
 */
function toOutputSchema(
  spec: OpenApiSpec,
  schema: any,
  ancestry: Set<string>,
  budget: { nodes: number },
  depth: number,
): JsonSchemaNode {
  if (!schema || depth > MAX_OUTPUT_SCHEMA_DEPTH || budget.nodes <= 0) return {};

  if (schema.$ref) {
    if (ancestry.has(schema.$ref)) return {}; // cycle guard
    const resolved = resolveRef(spec, schema.$ref);
    if (!resolved) return {};
    const next = new Set(ancestry);
    next.add(schema.$ref);
    return toOutputSchema(spec, resolved, next, budget, depth);
  }

  if (Array.isArray(schema.allOf)) {
    // Flatten allOf into a single object — MCP clients vary in composition
    // support, and a merged object is the safest common denominator.
    const merged: JsonSchemaNode = { type: 'object', properties: {} };
    for (const sub of schema.allOf) {
      const part = toOutputSchema(spec, sub, ancestry, budget, depth);
      if (part.properties) Object.assign(merged.properties!, part.properties);
      if (part.description && !merged.description) merged.description = part.description;
    }
    if (Object.keys(merged.properties!).length === 0) delete merged.properties;
    return merged;
  }

  // oneOf/anyOf collapse to match-anything: the spec uses them for polymorphic
  // payloads we cannot narrow safely.
  if (schema.oneOf || schema.anyOf) return {};

  budget.nodes--;
  const node: JsonSchemaNode = {};
  const type = outputType(schema);
  if (type) node.type = type;

  const desc = (schema.description || '').replace(/\s+/g, ' ').trim();
  if (desc) {
    node.description = desc.length > MAX_RESPONSE_FIELD_DESC
      ? `${desc.slice(0, MAX_RESPONSE_FIELD_DESC - 1)}…`
      : desc;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) node.enum = schema.enum;
  if (schema.format === 'date-time' || schema.format === 'date') node.format = schema.format;

  if (schema.type === 'array') {
    node.items = schema.items ? toOutputSchema(spec, schema.items, ancestry, budget, depth + 1) : {};
    return node;
  }

  if (schema.properties) {
    const properties: Record<string, JsonSchemaNode> = {};
    for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
      if (budget.nodes <= 0) break;
      // Skip the ServiceResponse envelope's diagnostic arrays. They appear on
      // every one of the 55 responses and describing them 55 times costs real
      // context for information the model never acts on. Omitting them is safe
      // precisely because the schema is permissive: they still arrive in the
      // payload and still validate as unconstrained extra properties.
      if (RESPONSE_ENVELOPE_SKIP.has(key)) continue;
      properties[key] = toOutputSchema(spec, value, ancestry, budget, depth + 1);
    }
    if (Object.keys(properties).length > 0) {
      node.properties = properties;
      node.type = 'object';
    }
  }

  return node;
}

/**
 * Builds a tool's `outputSchema` from its 2xx response, or null when the
 * response has no object-typed schema (MCP requires `type: "object"` at the
 * root, and a tool without an outputSchema simply returns text content).
 */
function buildOutputSchema(spec: OpenApiSpec, op: OperationObject): object | null {
  const responses = op.responses as Record<string, any> | undefined;
  if (!responses || typeof responses !== 'object') return null;
  const key =
    Object.keys(responses).find((k) => /^2\d\d$/.test(k)) ?? (responses['default'] ? 'default' : undefined);
  if (!key) return null;
  const content = responses[key]?.content;
  const schema = content && (content['application/json'] || Object.values(content)[0]);
  const sch = schema && (schema as any).schema;
  if (!sch) return null;

  const built = toOutputSchema(spec, sch, new Set(), { nodes: MAX_OUTPUT_SCHEMA_NODES }, 0);
  // MCP requires an object at the root, and an object with no described
  // properties tells the model nothing it doesn't already know.
  if (built.type !== 'object' || !built.properties) return null;
  return built;
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
        returnsDoc: buildReturnsDoc(spec, op),
        outputSchema: buildOutputSchema(spec, op),
        title: op.summary || '',
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
  // With an outputSchema the field semantics ship structurally; repeating them
  // as prose would double the description for no extra information.
  if (op.returnsDoc && !op.outputSchema) parts.push(op.returnsDoc);
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
  lines.push(`    return toCallToolResult(response${op.outputSchema ? '' : ', false'});`);

  return lines.join('\n');
}

function generateToolFile(_tag: string, operations: ParsedOperation[]): string {
  const lines: string[] = [];
  lines.push(`// Auto-generated by scripts/generate-tools.ts — DO NOT EDIT`);
  lines.push(`import type { ToolDefinition, GenericApiClient } from '../types.js';`);
  lines.push(`import { toCallToolResult } from '../types.js';`);
  lines.push(`import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';`);
  lines.push(``);

  for (const op of operations) {
    const desc = generateToolDescription(op);
    const inputSchema = generateInputSchema(op);
    const identifier = sanitizeIdentifier(op.toolName);
    lines.push(`export const ${identifier}: ToolDefinition = {`);
    lines.push(`  schema: {`);
    lines.push(`    name: '${escapeString(op.toolName)}',`);
    if (op.title) lines.push(`    title: '${escapeString(op.title)}',`);
    lines.push(`    description: '${escapeString(desc)}',`);
    lines.push(`    inputSchema: ${inputSchema.replace(/\n/g, '\n    ')},`);
    if (op.outputSchema) {
      const outputSchema = JSON.stringify(op.outputSchema, null, 6);
      lines.push(`    outputSchema: ${outputSchema.replace(/\n/g, '\n    ')},`);
    }
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

export interface ToolSchema {
  name: string;
  /** Human-readable display name (MCP 2025-06-18 \`title\`). */
  title?: string;
  description: string;
  inputSchema: object;
  /** JSON Schema 2020-12 for \`structuredContent\` (MCP 2025-06-18). */
  outputSchema?: object;
}

export interface ToolDefinition {
  schema: ToolSchema;
  handler: (args: Record<string, unknown>, client: GenericApiClient) => Promise<CallToolResult>;
}

/**
 * Structured output is on by default. Operators can fall back to text-only
 * results with MCP_STRUCTURED_OUTPUT=false — useful against a client that
 * validates \`structuredContent\` strictly and a Starlink response that has
 * drifted from the published spec.
 *
 * The toggle MUST be read by both the tool listing and the handlers: a tool
 * that advertises an outputSchema and then omits structuredContent is invalid.
 */
export function structuredOutputEnabled(): boolean {
  return process.env.MCP_STRUCTURED_OUTPUT !== 'false';
}

/** True for plain JSON objects — the only thing \`structuredContent\` accepts. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts a Starlink API response into a CallToolResult.
 *
 * Upstream failures come back as \`isError: true\` rather than a JSON-RPC error:
 * per MCP, errors originating *in* the tool belong in the result so the model
 * can see them and self-correct. Only failures to *find* the tool are protocol
 * errors.
 */
export function toCallToolResult(
  response: StarlinkApiResponse,
  withStructuredContent = true,
): CallToolResult {
  if (!response.success) {
    return {
      content: [{ type: 'text' as const, text: response.error ?? response.message ?? 'Starlink API request failed' }],
      isError: true,
    };
  }

  const payload = response.data;
  const result: CallToolResult = {
    content: [{ type: 'text' as const, text: JSON.stringify(payload ?? {}, null, 2) }],
  };
  if (withStructuredContent && structuredOutputEnabled()) {
    result.structuredContent = isPlainObject(payload) ? payload : {};
  }
  return result;
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
