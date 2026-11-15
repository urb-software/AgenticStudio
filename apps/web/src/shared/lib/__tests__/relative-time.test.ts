import { describe, expect, it } from 'vitest';
import { formatTimeAgo } from '../relative-time';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const ago = (iso: string) => formatTimeAgo(new Date(iso), NOW);

describe('formatTimeAgo', () => {
  it.each([
    ['2026-11-13T11:59:40.000Z', '20s ago'],
    ['2026-11-13T11:55:00.000Z', '5m ago'],
    ['2026-11-13T09:00:00.000Z', '3h ago'],
    ['2026-11-12T11:00:00.000Z', '1d ago'],
    ['2026-11-03T12:00:00.000Z', '1w ago'],
    ['2026-09-01T12:00:00.000Z', '2mo ago'],
    ['2024-11-01T12:00:00.000Z', '2y ago'],
  ])('%s is "%s"', (iso, expected) => {
    expect(ago(iso)).toBe(expected);
  });

  it('counts a date in the future (clock skew) as one second ago', () => {
    expect(ago('2026-11-13T12:00:05.000Z')).toBe('1s ago');
  });
});
