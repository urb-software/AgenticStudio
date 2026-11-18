import { runCheckSchema } from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { storedCheckSchema } from '../handler.js';

describe('the stored check shape follows the worker protocol', () => {
  const check = (patch: object) => ({ name: 'unit', result: 'passed', ...patch });

  it.each([
    ['a plain check', check({})],
    ['a name at its limit', check({ name: 'n'.repeat(200) })],
    ['a name over its limit', check({ name: 'n'.repeat(201) })],
    ['an empty name', check({ name: '' })],
    ['a detail at its limit', check({ detail: 'd'.repeat(4000) })],
    ['a detail over its limit', check({ detail: 'd'.repeat(4001) })],
    ['every result', check({ result: 'not_run' })],
    ['an unknown result', check({ result: 'skipped' })],
    ['an unknown key', check({ extra: 1 })],
  ])('judges %s like the protocol', (_name, value) => {
    expect(storedCheckSchema.safeParse(value).success).toBe(
      runCheckSchema.safeParse(value).success,
    );
  });
});
