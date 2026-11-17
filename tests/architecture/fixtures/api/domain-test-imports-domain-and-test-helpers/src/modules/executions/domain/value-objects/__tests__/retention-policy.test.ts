import { describe, expect, it } from 'vitest';
import { WEEK } from './policy.js';

describe('RetentionPolicy', () => {
  it('keeps a Run for its period', () => {
    expect(WEEK.keepsFor(7)).toBe(true);
  });
});
