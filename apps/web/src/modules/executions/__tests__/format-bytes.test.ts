import { describe, expect, it } from 'vitest';
import { formatBytes } from '../components/format-bytes';

describe('formatBytes (Issue #143)', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1 KiB'],
    [1536, '1.5 KiB'],
    [10 * 1024 ** 2, '10 MiB'],
    [3.2 * 1024 ** 3, '3.2 GiB'],
    [42 * 1024 ** 3, '42 GiB'],
    [1.25 * 1024 ** 4, '1.3 TiB'],
    [5000 * 1024 ** 4, '5000 TiB'],
  ])('writes %d bytes as %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});
