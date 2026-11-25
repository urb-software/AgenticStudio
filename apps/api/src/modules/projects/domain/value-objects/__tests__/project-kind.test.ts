import { describe, expect, it } from 'vitest';
import { isProjectKind, PROJECT_KIND_VALUES } from '../project-kind.js';

describe('ProjectKind', () => {
  it('is code or definitions', () => {
    expect([...PROJECT_KIND_VALUES]).toEqual(['code', 'definitions']);
  });

  it.each(['code', 'definitions'])('accepts %s', (value) => {
    expect(isProjectKind(value)).toBe(true);
  });

  it.each(['Code', 'definition', '', null, undefined, 1])('refuses %j', (value) => {
    expect(isProjectKind(value)).toBe(false);
  });
});
