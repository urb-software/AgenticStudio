import { z } from 'zod';
import { agentResultSchema } from '../agent-definition/index.js';

/**
 * The structured result's JSON Schema for Codex (`--output-schema`, coordinator smoke of #133).
 * Codex sends it to the provider as a strict structured output, which refuses the shared schema
 * ("'required' is required to include every key in properties"): every object must list all of
 * its properties as required and set `additionalProperties: false`, so an optional field becomes
 * nullable (`anyOf` with `null`). String length bounds are left out (strict mode may refuse
 * them); the worker still validates the result strictly against the agent result schema after
 * {@link withoutNulls}.
 */

type Schema = Record<string, unknown>;

const isObject = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keywords left out of the Codex schema; the worker's own validation enforces them. */
const DROPPED = new Set(['minLength', 'maxLength', '$schema']);

/** `schema` made strict: all properties required, optional ones nullable, no extra keys. */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!isObject(schema)) return schema;
  const out: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED.has(key)) continue;
    if (key === 'properties' && isObject(value)) {
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const properties: Schema = {};
      for (const [name, property] of Object.entries(value)) {
        const strict = strictSchema(property);
        properties[name] = required.has(name) ? strict : { anyOf: [strict, { type: 'null' }] };
      }
      out.properties = properties;
      out.required = Object.keys(value);
      out.additionalProperties = false;
    } else if (key !== 'required' && key !== 'additionalProperties') {
      out[key] = strictSchema(value);
    }
  }
  if (out.type === 'object' && out.properties === undefined) {
    out.properties = {};
    out.required = [];
    out.additionalProperties = false;
  }
  return out;
}

/** {@link agentResultSchema} as a strict JSON Schema for Codex's `--output-schema`, as JSON. */
export const CODEX_RESULT_JSON_SCHEMA = JSON.stringify(
  strictSchema(z.toJSONSchema(agentResultSchema, { target: 'draft-7' })),
);

/** `value` with every `null` property removed (at any depth): a strict output's absent fields. */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isObject(value)) return value;
  const out: Schema = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== null) out[key] = withoutNulls(field);
  }
  return out;
}
