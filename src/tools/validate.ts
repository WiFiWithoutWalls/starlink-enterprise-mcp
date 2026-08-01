/**
 * Tool argument validation.
 *
 * MCP 2025-11-25 (SEP-1303) clarified that input validation failures should be
 * returned as *tool execution* errors, not protocol errors, so the model can
 * read what went wrong and retry with corrected arguments. This module does the
 * checking; src/tools/index.ts turns a failure into `isError: true`.
 *
 * Without this, a missing required path parameter used to sail through to the
 * client and produce a request against a literal `/routers/{routerId}/reboot`
 * URL — a 404 that told the model nothing about the real mistake.
 */

// The 2020 build, not the default draft-07 one: MCP 2025-11-25 (SEP-1613)
// makes JSON Schema 2020-12 the dialect for tool schemas.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

export type ValidationOutcome =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * `coerceTypes` is deliberate: models routinely send `"50"` for a numeric
 * parameter. Rejecting that would be pedantic when the intent is unambiguous,
 * so we coerce and hand the corrected value to the handler.
 *
 * `strict: false` matches the generated schemas, which use only the subset of
 * JSON Schema the OpenAPI spec expresses.
 */
const ajv = new Ajv2020({ strict: false, coerceTypes: true, allErrors: true });

const validators = new Map<string, ValidateFunction | null>();

function getValidator(cacheKey: string, schema: object): ValidateFunction | null {
  if (!validators.has(cacheKey)) {
    try {
      validators.set(cacheKey, ajv.compile(schema));
    } catch {
      // A schema we cannot compile must not block the tool: fall back to
      // passing arguments through untouched, exactly as before validation existed.
      validators.set(cacheKey, null);
    }
  }
  return validators.get(cacheKey) ?? null;
}

function formatErrors(errors: ErrorObject[]): string {
  return errors
    .slice(0, 5)
    .map((err) => {
      const path = err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\//g, '.') : '';
      const where = path ? `'${path}'` : 'arguments';
      if (err.keyword === 'required') {
        return `missing required parameter '${(err.params as { missingProperty: string }).missingProperty}'`;
      }
      if (err.keyword === 'enum') {
        const allowed = (err.params as { allowedValues: unknown[] }).allowedValues;
        return `${where} must be one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}`;
      }
      return `${where} ${err.message ?? 'is invalid'}`;
    })
    .join('; ');
}

/**
 * Validates and type-coerces tool arguments against the tool's input schema.
 *
 * The input object is cloned before coercion so a caller's arguments are never
 * mutated underneath it.
 */
export function validateToolInput(
  toolKey: string,
  schema: object,
  args: Record<string, unknown>,
): ValidationOutcome {
  const validate = getValidator(toolKey, schema);
  if (!validate) return { ok: true, args };

  const candidate = structuredClone(args);
  if (validate(candidate)) return { ok: true, args: candidate as Record<string, unknown> };
  return { ok: false, error: formatErrors(validate.errors ?? []) };
}

/** Test hook — drops compiled validators so schema changes are picked up. */
export function resetValidatorCache(): void {
  validators.clear();
}
