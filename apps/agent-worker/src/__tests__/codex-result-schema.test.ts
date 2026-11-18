import { describe, expect, it } from 'vitest';
import { CODEX_RESULT_JSON_SCHEMA, strictSchema, withoutNulls } from '../codex/result-schema.js';
import { CodexStream } from '../codex/stream.js';

// Strict at every object level: Codex's provider refuses a schema whose `required` omits a key.

type Node = Record<string, unknown>;

/** Every object schema in `schema`, at any depth. */
function objects(schema: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(schema)) for (const item of schema) objects(item, found);
  else if (typeof schema === 'object' && schema !== null) {
    const node = schema as Node;
    if (node.type === 'object') found.push(node);
    for (const value of Object.values(node)) objects(value, found);
  }
  return found;
}

describe("Codex's result schema", () => {
  const schema = JSON.parse(CODEX_RESULT_JSON_SCHEMA) as Node;

  it('lists every property as required and forbids extra keys, at every object level', () => {
    const found = objects(schema);
    // The result, the question, the pull request and a check.
    expect(found).toHaveLength(4);
    for (const node of found) {
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toEqual(Object.keys(node.properties as Node));
    }
  });

  it('keeps the required fields as they are and makes the optional ones nullable', () => {
    const properties = schema.properties as Node;
    expect(properties.outcome).toEqual({ type: 'string', enum: ['done', 'needs_input'] });
    expect(properties.summary).toEqual({ type: 'string' });
    for (const name of ['question', 'pullRequest', 'checks']) {
      expect((properties[name] as { anyOf: unknown[] }).anyOf.at(-1)).toEqual({ type: 'null' });
    }
  });

  it('carries no $schema and no string length bounds', () => {
    expect(CODEX_RESULT_JSON_SCHEMA).not.toMatch(/"\$schema"|"minLength"|"maxLength"/);
  });

  it('makes a nested object without properties strict too', () => {
    expect(strictSchema({ type: 'object' })).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });
});

describe('null normalisation', () => {
  it('removes null fields at any depth', () => {
    expect(
      withoutNulls({ a: null, b: { c: null, d: 1 }, e: [{ f: null, g: 'x' }], h: 'y' }),
    ).toEqual({ b: { d: 1 }, e: [{ g: 'x' }], h: 'y' });
  });

  it("accepts a strict output's nulls as absent fields in the step's result", () => {
    const stream = new CodexStream();
    stream.accept(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
    stream.accept(JSON.stringify({ type: 'turn.completed' }));
    const text = JSON.stringify({
      outcome: 'needs_input',
      summary: 'Which store?',
      question: { text: 'Which store?', options: null, recommendation: null },
      pullRequest: null,
      checks: [{ name: 'npm test', result: 'not_run', detail: null }],
    });

    expect(stream.finish({ exitCode: 0, spawnFailed: false }, { kind: 'file', text })).toEqual({
      result: {
        outcome: 'needs_input',
        summary: 'Which store?',
        question: { text: 'Which store?' },
        checks: [{ name: 'npm test', result: 'not_run' }],
        sessionRef: 'thread-1',
      },
      events: [],
    });
  });
});
