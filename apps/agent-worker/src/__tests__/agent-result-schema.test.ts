import { runStepResultSchema } from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { AGENT_RESULT_JSON_SCHEMA, REVIEW_RESULT_JSON_SCHEMA } from '../agent-definition/index.js';

// The schema carries no `$schema` and draft-07 keywords only: CLI 2.1.325 refuses draft 2020-12.

const schema = JSON.parse(AGENT_RESULT_JSON_SCHEMA) as Record<string, unknown>;

/** Every key anywhere in a JSON value. */
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]);
}

describe('the structured result JSON Schema (--json-schema)', () => {
  it('names no draft and uses no keyword newer than draft-07', () => {
    expect(AGENT_RESULT_JSON_SCHEMA).not.toContain('2020-12');
    expect(schema).not.toHaveProperty('$schema');
    for (const newer of [
      '$defs',
      'prefixItems',
      'unevaluatedProperties',
      'unevaluatedItems',
      'dependentRequired',
      'dependentSchemas',
      '$dynamicRef',
      '$dynamicAnchor',
      '$anchor',
      '$vocabulary',
    ]) {
      expect(keys(schema)).not.toContain(newer);
    }
  });

  it('is exactly the agent-facing result: the protocol result without the session reference', () => {
    const text = { type: 'string', minLength: 1 };
    expect(schema).toEqual({
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['done', 'needs_input'] },
        summary: { type: 'string', maxLength: 20000 },
        question: {
          type: 'object',
          properties: {
            text: { ...text, maxLength: 4000 },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: { ...text, maxLength: 200 },
            },
            recommendation: { ...text, maxLength: 200 },
          },
          required: ['text'],
          additionalProperties: false,
        },
        pullRequest: {
          type: 'object',
          properties: {
            title: { ...text, maxLength: 256 },
            body: { type: 'string', maxLength: 65536 },
          },
          required: ['title', 'body'],
          additionalProperties: false,
        },
        checks: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              name: { ...text, maxLength: 200 },
              result: { type: 'string', enum: ['passed', 'failed', 'not_run'] },
              detail: { type: 'string', maxLength: 4000 },
            },
            required: ['name', 'result'],
            additionalProperties: false,
          },
        },
      },
      required: ['outcome', 'summary'],
      additionalProperties: false,
    });
  });

  it('describes only results the worker protocol accepts, a work step without the Verdict', () => {
    expect(Object.keys(schema.properties as object).sort()).toEqual(
      Object.keys(runStepResultSchema.shape)
        .filter((key) => !['sessionRef', 'verdict', 'findings'].includes(key))
        .sort(),
    );
  });

  it('describes for a review step every key the worker protocol accepts but the session', () => {
    const review = JSON.parse(REVIEW_RESULT_JSON_SCHEMA) as { properties: object };
    expect(Object.keys(review.properties).sort()).toEqual(
      Object.keys(runStepResultSchema.shape)
        .filter((key) => key !== 'sessionRef')
        .sort(),
    );
  });
});
