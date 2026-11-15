import { describe, expect, it } from 'vitest';
import { formatDuration } from '../duration';

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [12_400, '12s'],
    [252_000, '4m 12s'],
    [300_000, '5m 0s'],
    [3_780_000, '1h 3m'],
    [-5_000, '0s'],
  ])('%i ms is "%s"', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
