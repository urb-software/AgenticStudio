import { describe, expect, it } from 'vitest';
import { ControllerAvailability } from '../controller-availability.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const seconds = (count: number) => new Date(NOW.getTime() + count * 1000);
const LEASE = 60;

const of = (lastSeen: number | null, startedAt: number) =>
  ControllerAvailability.of({
    lastSeenAt: lastSeen === null ? null : seconds(lastSeen),
    startedAt: seconds(startedAt),
    leaseSeconds: LEASE,
  });

describe('ControllerAvailability', () => {
  it('is connected when a controller called within one lease', () => {
    expect(of(-60, -1000).connected(NOW)).toBe(true);
    expect(of(-61, -1000).connected(NOW)).toBe(false);
    expect(of(null, -1000).connected(NOW)).toBe(false);
  });

  it('is known absent when not connected and the API ran for a lease', () => {
    expect(of(null, -60).knownAbsent(NOW)).toBe(true);
    expect(of(-500, -1000).knownAbsent(NOW)).toBe(true);
  });

  it('knows nothing in the start-up grace', () => {
    expect(of(null, -59).knownAbsent(NOW)).toBe(false);
    expect(of(null, 0).knownAbsent(NOW)).toBe(false);
  });

  it('is never known absent while connected', () => {
    expect(of(-10, -1000).knownAbsent(NOW)).toBe(false);
  });
});
