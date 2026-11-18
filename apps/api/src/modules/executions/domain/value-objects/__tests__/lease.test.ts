import { describe, expect, it } from 'vitest';
import { Lease } from '../lease.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe('Lease', () => {
  it('covers a moment up to and including its length', () => {
    const lease = Lease.ofSeconds(60);
    expect(lease.covers(ago(0), NOW)).toBe(true);
    expect(lease.covers(ago(60), NOW)).toBe(true);
    expect(lease.covers(ago(61), NOW)).toBe(false);
  });

  it('covers nothing that was never seen', () => {
    expect(Lease.ofSeconds(60).covers(undefined, NOW)).toBe(false);
  });
});
