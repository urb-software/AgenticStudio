import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeForHint } from '../normalize-for-hint';

// The same vector is checked against the API's normalizeProjectName
// (apps/api/.../create-project/__tests__/handler.test.ts), so the two copies cannot drift.
const VECTOR = resolve(process.cwd(), '../../tests/fixtures/project-name-normalization.json');
const { cases } = JSON.parse(readFileSync(VECTOR, 'utf8')) as {
  cases: { name: string; input: string; expected: string }[];
};

describe('normalizeForHint: shared project-name normalization vector', () => {
  it.each(cases.map((c) => [c.name, c.input, c.expected] as const))(
    '%s',
    (_name, input, expected) => {
      expect(normalizeForHint(input)).toBe(expected);
    },
  );
});
