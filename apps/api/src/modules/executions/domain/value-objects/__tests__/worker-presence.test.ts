import { describe, expect, it } from 'vitest';
import { Lease } from '../lease.js';
import type { WorkerStatusData } from '../worker-status-data.js';
import { WorkerPresence } from '../worker-presence.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const LEASE = Lease.ofSeconds(60);
const status = (ageSeconds: number): WorkerStatusData => ({
  workerId: '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d',
  runner: 'cli',
  providers: { claude_code: true, codex: false },
  reportedAt: new Date(NOW.getTime() - ageSeconds * 1000),
});

describe('WorkerPresence', () => {
  it('has a connected worker up to the lease and none after it or without a report', () => {
    expect(WorkerPresence.of(status(60), LEASE).isAnyConnected(NOW)).toBe(true);
    expect(WorkerPresence.of(status(61), LEASE).isAnyConnected(NOW)).toBe(false);
    expect(WorkerPresence.of(undefined, LEASE).isAnyConnected(NOW)).toBe(false);
  });

  it('lists every provider as unavailable when no worker is connected', () => {
    const all = WorkerPresence.of(status(61), LEASE).providerAvailability(NOW);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((provider) => !provider.available && provider.reason)).toBe(true);
  });

  it('lists a switched-on provider as available', () => {
    const all = WorkerPresence.of(status(0), LEASE).providerAvailability(NOW);
    expect(all.find((provider) => provider.id === 'claude_code')?.available).toBe(true);
    expect(all.find((provider) => provider.id === 'codex')?.available).toBe(false);
  });
});
