import { describe, expect, it } from 'vitest';
import { isProjectKind, PROJECT_KINDS } from '../project-kind.js';

describe('ProjectKind', () => {
  it('is code or definitions', () => {
    expect([...PROJECT_KINDS]).toEqual(['code', 'definitions']);
  });

  it.each(['code', 'definitions'])('accepts %s', (value) => {
    expect(isProjectKind(value)).toBe(true);
  });

  it.each(['Code', 'definition', '', null, undefined, 1])('refuses %j', (value) => {
    expect(isProjectKind(value)).toBe(false);
  });
});
