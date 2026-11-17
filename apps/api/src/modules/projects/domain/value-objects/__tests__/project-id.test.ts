import { describe, expect, it } from 'vitest';
import { isProjectId } from '../project-id.js';

describe('isProjectId', () => {
  it('accepts a UUID in either case', () => {
    expect(isProjectId('3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e')).toBe(true);
    expect(isProjectId('3F2B8C1E-4D5A-4B6C-9D7E-8F9A0B1C2D3E')).toBe(true);
  });

  it.each([
    '',
    'not-an-id',
    '3f2b8c1e4d5a4b6c9d7e8f9a0b1c2d3e',
    '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e ',
  ])('refuses %j: it names no project', (value) => {
    expect(isProjectId(value)).toBe(false);
  });
});
